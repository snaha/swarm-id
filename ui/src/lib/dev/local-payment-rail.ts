// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DEV ONLY — the payment rail that stands in for Relay on a local chain.
 *
 * Relay cannot be reproduced locally at all: it is an intent/solver network, so
 * the quote comes from a hosted API that resolves chains against its own
 * registry, and the delivery is an off-chain solver paying out of its own
 * inventory on real Gnosis. A deposit signed on a local fork is seen by nobody.
 *
 * What CAN be reproduced is the shape. The baked chain's faucet already is a
 * solver — it holds inventory on the destination chain and pays out on demand —
 * so all that is missing is the trigger. This rail supplies one:
 *
 *   1. the user's real wallet signs a real deposit on a local source chain,
 *      carrying the delivery instruction in its calldata,
 *   2. a separate solver process (`@swarm-id/multichain`'s `local-solver.ts`,
 *      started by `pnpm dev:local`) sees it and pays out on the Gnosis chain,
 *   3. we wait here for money we do not control to arrive.
 *
 * That third step is why the solver is a service and not a function call: the
 * app's job on a real rail is to sign and then wait, and it can only rehearse
 * that if something else does the delivering. Stop the solver and a payment
 * hangs and times out, which is exactly what a solver outage looks like.
 *
 * From there nothing is faked: the delivered xDAI is swapped to BZZ through the
 * real Sushi pool and spent by the postage engine, exactly as in production.
 *
 * What it does NOT cover, and must not be read as covering: Relay's pricing,
 * routing and error surface (the numbers here are invented); its real step
 * model (an ERC-20 source needs an approve before the deposit — one native
 * transfer collapses that); and its failure/refund semantics.
 *
 * Production code must never import this module.
 */
import { sleep, withTimeout } from '@snaha/swarm-id'
import { LOCAL_SOLVER_ADDRESS, devRpc, encodeDeliveryInstruction } from '@swarm-id/multichain/dev'
import { type Chain, defineChain, formatUnits } from 'viem'

import { postageChain, probeChainId } from '$lib/payment/chain'
import {
  type ExecutePaymentOptions,
  NATIVE_CURRENCY,
  type PaymentQuote,
  type PaymentRail,
  type PaymentToken,
  type QuoteRequest,
  displayAmount,
  displayUsd,
} from '$lib/payment/payment-rail'

/** Where `pnpm dev:source-chain` listens. */
export const DEFAULT_SOURCE_RPC_URL = 'http://localhost:31337'

/**
 * Lets a test pin the source chain rather than inherit whatever happens to be
 * running. Without it, whether the payment screens open depends on a developer
 * having `pnpm dev:local` up — so the same suite behaves differently on a
 * laptop and in CI, which is the worst kind of flake.
 */
export const SOURCE_RPC_OVERRIDE_KEY = 'swarm-id-dev-source-rpc'

export function localSourceRpcUrl(): string {
  return (
    (typeof localStorage !== 'undefined' && localStorage.getItem(SOURCE_RPC_OVERRIDE_KEY)) ||
    DEFAULT_SOURCE_RPC_URL
  )
}

/**
 * Deliberately anvil's own default, not 1: with the rail mocked the source
 * chain never talks to Relay, so its id is free, and one that reads as local
 * cannot be confused with a real chain by a wallet that has both configured.
 */
export const LOCAL_SOURCE_CHAIN_ID = 31337

/**
 * Source-token units per xDAI. Invented, and deliberately not 1: a realistic
 * rate keeps the quoted amounts at the magnitude of real ETH figures, so the
 * dialog's formatting and its breakdown-row share math are exercised on numbers
 * shaped like the ones production produces.
 */
const XDAI_PER_SOURCE_UNIT = 4000n

/** Native-currency decimals, on both the source chain and Gnosis. */
const WEI_DECIMALS = 18

const RECEIPT_POLL_MS = 500
const RECEIPT_TIMEOUT_MS = 60_000

/**
 * How long to wait for the solver to pay out. Generous — a real cross-chain
 * delivery is minutes-scale worst case — but finite, so a stopped solver
 * surfaces as a failed payment rather than a dialog that spins forever.
 */
const DELIVERY_POLL_MS = 1_000
const DELIVERY_TIMEOUT_MS = 120_000

function localSourceChain(): Chain {
  return defineChain({
    id: LOCAL_SOURCE_CHAIN_ID,
    name: 'Ethereum Mainnet (fake)',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: WEI_DECIMALS },
    rpcUrls: { default: { http: [localSourceRpcUrl()] } },
  })
}

const LOCAL_TOKENS: PaymentToken[] = [
  { address: NATIVE_CURRENCY, symbol: 'ETH', name: 'Ether', decimals: WEI_DECIMALS },
]

/** What `quoteLocalPayment` hands to `execute` — this rail's private payload. */
interface LocalPaymentHandle {
  /** The batch-owner address the xDAI must land on. Narrowed here, once, so
   * the solver protocol and the chain client both get the shape they want. */
  recipient: `0x${string}`
  /** Exact xDAI (wei) the faucet must deliver there. */
  xdaiWei: bigint
  /** Source-chain native amount (wei) the user signs away. */
  amountSourceWei: bigint
}

function isLocalHandle(handle: unknown): handle is LocalPaymentHandle {
  const candidate = handle as LocalPaymentHandle | undefined
  return (
    typeof candidate?.recipient === 'string' &&
    typeof candidate.xdaiWei === 'bigint' &&
    typeof candidate.amountSourceWei === 'bigint'
  )
}

/**
 * Price a local payment. Pure and synchronous — there is no quoting service to
 * ask, only the fixed rate. xDAI is a dollar stablecoin, so the USD figure is
 * the xDAI amount itself.
 */
export function quoteLocalPayment(request: QuoteRequest): PaymentQuote {
  const amountSourceWei = request.xdaiWei / XDAI_PER_SOURCE_UNIT
  const handle: LocalPaymentHandle = {
    recipient: request.recipient as `0x${string}`,
    xdaiWei: request.xdaiWei,
    amountSourceWei,
  }
  return {
    handle,
    amountFormatted: displayAmount(formatUnits(amountSourceWei, WEI_DECIMALS)),
    // xDAI is a dollar stablecoin, so the USD figure is the xDAI amount itself.
    amountUsd: displayUsd(formatUnits(request.xdaiWei, WEI_DECIMALS)),
    // A bridged rail delivers native xDAI and nothing else — carrying the
    // user's own token across would mean holding inventory in it. The gas
    // share arrives as xDAI too but is not swapped, so only the rest is.
    delivers: { input: 'xdai', amount: request.xdaiWei - request.gasXdaiWei },
  }
}

const sourceRpc = (method: string, params: unknown[]): Promise<unknown> =>
  devRpc(localSourceRpcUrl(), method, params)

/**
 * Poll `check` until it reports done, or give up with `message`.
 *
 * The cancellation flag is the point: `withTimeout` rejects the caller but
 * cannot stop the loop behind it, so without this the poll would keep hitting
 * the chain forever after a payment had already failed.
 */
async function pollUntil(
  check: () => Promise<boolean>,
  options: { intervalMs: number; timeoutMs: number; message: string },
): Promise<void> {
  let cancelled = false
  const loop = async () => {
    while (!cancelled) {
      if (await check()) {
        return
      }
      await sleep(options.intervalMs)
    }
  }
  try {
    await withTimeout(loop(), options.timeoutMs, options.message)
  } finally {
    cancelled = true
  }
}

/**
 * Wait for the deposit to confirm ON THE SOURCE CHAIN WE KNOW ABOUT, rather
 * than through the wallet's provider. If the wallet is pointed at a different
 * network the deposit lands somewhere we will never see, and asking our own
 * endpoint is what makes that misconfiguration fail loudly instead of being
 * papered over by a fill that happens anyway.
 */
async function waitForDeposit(transactionHash: string): Promise<void> {
  await pollUntil(
    async () => {
      const receipt = (await sourceRpc('eth_getTransactionReceipt', [transactionHash])) as
        | { status?: string }
        | undefined
        | null
      if (!receipt) {
        return false
      }
      if (receipt.status !== '0x1') {
        throw new Error('The payment transaction reverted on the local source chain.')
      }
      return true
    },
    {
      intervalMs: RECEIPT_POLL_MS,
      timeoutMs: RECEIPT_TIMEOUT_MS,
      message: `The payment was never seen on the local source chain. Check that your wallet's network is ${localSourceRpcUrl()} (chain ${LOCAL_SOURCE_CHAIN_ID}).`,
    },
  )
}

/** Native balance on the local source chain, in wei. */
export async function sourceEthBalance(address: string): Promise<bigint> {
  return BigInt((await sourceRpc('eth_getBalance', [address, 'latest'])) as string)
}

/**
 * Hand an address source-chain ETH.
 *
 * Minted rather than transferred: the source chain is a bare anvil with no bake
 * behind it, so there is no faucet account to send from — the cheat code is the
 * only source of funds here. Added to the balance rather than assigned, so two
 * sends accumulate the way a faucet's would.
 */
export async function mintSourceEth(address: string, wei: bigint): Promise<void> {
  const balance = await sourceEthBalance(address).catch(() => {
    throw new Error(
      `No source chain answering at ${localSourceRpcUrl()} — start it with \`pnpm dev:source-chain\` (or the whole stack with \`pnpm dev:local\`).`,
    )
  })
  await sourceRpc('anvil_setBalance', [address, `0x${(balance + wei).toString(16)}`])
}

/**
 * Wait for the solver to pay out, by watching the recipient's xDAI on the
 * Gnosis-side chain. This is the whole point of the rail being split: the app
 * signs, then waits on money it does not control, exactly as it waits on Relay.
 */
async function waitForDelivery(recipient: `0x${string}`, before: bigint): Promise<void> {
  const chain = await postageChain()
  await pollUntil(async () => (await chain.getNativeBalance(recipient)) > before, {
    intervalMs: DELIVERY_POLL_MS,
    timeoutMs: DELIVERY_TIMEOUT_MS,
    message:
      'The payment was taken but never delivered. Is the local solver running? (pnpm dev:local)',
  })
}

/**
 * Take the deposit from the user's wallet, then wait for the solver to deliver.
 *
 * No status is reported until the wallet has returned a hash: the dialog swaps
 * its "approve the payment in your wallet" screen for the progress card on the
 * first status, so reporting one earlier would talk over the wallet prompt.
 */
async function executeLocalPayment(options: ExecutePaymentOptions): Promise<void> {
  const handle = options.quote.handle
  if (!isLocalHandle(handle)) {
    throw new Error('This payment was quoted by a different rail.')
  }

  // Read before signing: delivery is judged by this balance rising.
  const chain = await postageChain()
  const before = await chain.getNativeBalance(handle.recipient)

  const transactionHash = (await options.provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: options.address,
        to: LOCAL_SOLVER_ADDRESS,
        value: `0x${handle.amountSourceWei.toString(16)}`,
        data: encodeDeliveryInstruction(handle),
      },
    ],
  })) as string

  options.onStatus?.('Confirming your payment')
  await waitForDeposit(transactionHash)

  options.onStatus?.('Cross-swap xDAI on Relay')
  await waitForDelivery(handle.recipient, before)
}

const localPaymentRail: PaymentRail = {
  get chains() {
    // Read per access, so editing the endpoint in Network settings takes effect
    // without a reload — and so this module has no top-level side effect.
    return [localSourceChain()]
  },
  tokens: (chainId) => (chainId === LOCAL_SOURCE_CHAIN_ID ? LOCAL_TOKENS : []),
  quote: (request) => Promise.resolve(quoteLocalPayment(request)),
  execute: executeLocalPayment,
}

/**
 * The local rail, if there is a local source chain to sign on.
 *
 * Probed rather than cached: it is a connection-refused-fast call on localhost
 * that only runs when a payment is actually needed, and caching would mean
 * starting the chain mid-session had no effect. The chain id is checked too, so
 * an unrelated service on the port is not mistaken for the source chain.
 */
export async function resolveLocalRail(): Promise<PaymentRail | undefined> {
  const chainId = await probeChainId(localSourceRpcUrl()).catch(() => undefined)
  return chainId === LOCAL_SOURCE_CHAIN_ID ? localPaymentRail : undefined
}

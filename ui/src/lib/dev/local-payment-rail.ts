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
 * routing and error surface (the numbers here are invented, the step names
 * are its wording rather than its steps) and its failure/refund semantics.
 * The step SHAPE is mirrored, though: a native payment is one signature, and
 * a token one is approve-then-deposit, as on the real rail.
 *
 * Production code must never import this module.
 */
import { sleep, withTimeout } from '@snaha/swarm-id'
import {
  LOCAL_SOLVER_ADDRESS,
  LOCAL_SOURCE_USDC_ADDRESS,
  devRpc,
  encodeDeliveryInstruction,
} from '@swarm-id/multichain/dev'
import { type Chain, defineChain, encodeFunctionData, erc20Abi, formatUnits, parseAbi } from 'viem'

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

/** The mock USDC mirrors the real thing, six decimals included. */
const USDC_DECIMALS = 6

/**
 * xDAI wei per USDC base unit: both are dollars, so the rate is 1, and the
 * factor is purely the 18→6 decimals gap.
 */
const XDAI_WEI_PER_USDC_UNIT = 10n ** BigInt(WEI_DECIMALS - USDC_DECIMALS)

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

/** The pair the real mainnet offers, mirrored: ETH plus USDC, and USDC at
 * mainnet's own address, since the solver installs the mock there. */
const LOCAL_TOKENS: PaymentToken[] = [
  { address: NATIVE_CURRENCY, symbol: 'ETH', name: 'Ether', decimals: WEI_DECIMALS },
  {
    address: LOCAL_SOURCE_USDC_ADDRESS,
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: USDC_DECIMALS,
  },
]

/** What `quoteLocalPayment` hands to `execute` — this rail's private payload. */
interface LocalPaymentHandle {
  /** The batch-owner address the xDAI must land on. Narrowed here, once, so
   * the solver protocol and the chain client both get the shape they want. */
  recipient: `0x${string}`
  /** Exact xDAI (wei) the faucet must deliver there. */
  xdaiWei: bigint
  /** Source-chain amount the user signs away — native wei, or the token's own
   * base units when `token` is set. */
  amountSourceWei: bigint
  /** The ERC-20 being paid with; absent for a native payment. */
  token?: `0x${string}`
}

function isLocalHandle(handle: unknown): handle is LocalPaymentHandle {
  const candidate = handle as LocalPaymentHandle | undefined
  return (
    typeof candidate?.recipient === 'string' &&
    typeof candidate.xdaiWei === 'bigint' &&
    typeof candidate.amountSourceWei === 'bigint' &&
    (candidate.token === undefined || typeof candidate.token === 'string')
  )
}

/**
 * Price a local payment. Pure and synchronous — there is no quoting service to
 * ask, only the fixed rates. xDAI is a dollar stablecoin, so the USD figure is
 * the xDAI amount itself.
 */
export function quoteLocalPayment(request: QuoteRequest): PaymentQuote {
  const usdc = request.currency === LOCAL_SOURCE_USDC_ADDRESS
  // The USDC leg rounds UP: truncation could price a nonzero delivery at zero
  // token units, which encodes as a pull of nothing and a payment the solver
  // rightly refuses to fill — and a real rail never charges under cost either.
  const amountSourceWei = usdc
    ? (request.xdaiWei + XDAI_WEI_PER_USDC_UNIT - 1n) / XDAI_WEI_PER_USDC_UNIT
    : request.xdaiWei / XDAI_PER_SOURCE_UNIT
  const handle: LocalPaymentHandle = {
    recipient: request.recipient as `0x${string}`,
    xdaiWei: request.xdaiWei,
    amountSourceWei,
    ...(usdc ? { token: LOCAL_SOURCE_USDC_ADDRESS } : {}),
  }
  return {
    handle,
    amountFormatted: displayAmount(
      formatUnits(amountSourceWei, usdc ? USDC_DECIMALS : WEI_DECIMALS),
    ),
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
 * Mock-USDC balance on the local source chain, in the token's base units.
 * Rejects while the mock is not installed — a call to a codeless address
 * answers `0x`, and reporting that as a zero balance would hide that the
 * token does not exist yet.
 */
export async function sourceUsdcBalance(address: string): Promise<bigint> {
  const result = (await sourceRpc('eth_call', [
    {
      to: LOCAL_SOURCE_USDC_ADDRESS,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address as `0x${string}`],
      }),
    },
    'latest',
  ])) as string
  if (result === '0x') {
    throw new Error(
      'No mock USDC on the source chain yet — the solver installs it at startup (pnpm dev:local).',
    )
  }
  return BigInt(result)
}

/** The mock's own open mint — see `MockUsdc.sol` for why it is ungated. */
const MOCK_USDC_MINT_ABI = parseAbi(['function mint(address to, uint256 value)'])

/** Anvil's first default account signs the mint; any unlocked account would do. */
const SOURCE_MINTER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'

/**
 * Hand an address mock USDC, through the token's own open mint.
 *
 * The code check first is what turns "sent, but nothing arrived" into an
 * actionable message: a transaction to a codeless address succeeds as a no-op,
 * and the mock is only installed by the solver at ITS startup.
 */
export async function mintSourceUsdc(address: string, units: bigint): Promise<void> {
  const code = await sourceRpc('eth_getCode', [LOCAL_SOURCE_USDC_ADDRESS, 'latest']).catch(() => {
    throw new Error(
      `No source chain answering at ${localSourceRpcUrl()} — start it with \`pnpm dev:source-chain\` (or the whole stack with \`pnpm dev:local\`).`,
    )
  })
  if (typeof code !== 'string' || code === '0x') {
    throw new Error(
      'No mock USDC on the source chain yet — the solver installs it at startup (pnpm dev:local).',
    )
  }
  await sourceRpc('eth_sendTransaction', [
    {
      from: SOURCE_MINTER,
      to: LOCAL_SOURCE_USDC_ADDRESS,
      data: encodeFunctionData({
        abi: MOCK_USDC_MINT_ABI,
        functionName: 'mint',
        args: [address as `0x${string}`, units],
      }),
    },
  ])
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
 * Take the payment from the user's wallet, then wait for the solver to deliver.
 *
 * A native payment is one signature: the deposit itself, its value the payment
 * and its calldata the instruction. A token payment is two, the way Relay's
 * ERC-20 step model is: an approve granting the solver its pull, then a
 * value-less deposit whose instruction names what to pull — the solver
 * collects with `transferFrom` before filling.
 *
 * No status is reported until the wallet has returned the first hash: the
 * dialog swaps its "approve the payment in your wallet" screen for the
 * progress card on the first status, so reporting one earlier would talk over
 * the wallet prompt. The second prompt is announced through the card instead,
 * which is also how Relay's own step reports read.
 */
async function executeLocalPayment(options: ExecutePaymentOptions): Promise<void> {
  const handle = options.quote.handle
  if (!isLocalHandle(handle)) {
    throw new Error('This payment was quoted by a different rail.')
  }
  // The production rail's SDK structured-clones the quote it executes, so a
  // quote that cannot be cloned — above all one wrapped in a deep-reactive
  // `$state` proxy on its way through the dialog — breaks only there, in
  // production. Cloning here too makes the rehearsal fail the same way.
  structuredClone(options.quote)

  // Read before signing: delivery is judged by this balance rising.
  const chain = await postageChain()
  const before = await chain.getNativeBalance(handle.recipient)

  if (handle.token) {
    const approveHash = (await options.provider.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from: options.address,
          to: handle.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [LOCAL_SOLVER_ADDRESS, handle.amountSourceWei],
          }),
        },
      ],
    })) as string
    options.onStatus?.('Confirming the approval')
    await waitForDeposit(approveHash)
    options.onStatus?.('Confirm the payment in your wallet')
  }

  const instruction = handle.token
    ? {
        recipient: handle.recipient,
        xdaiWei: handle.xdaiWei,
        pull: { token: handle.token, amountWei: handle.amountSourceWei },
      }
    : { recipient: handle.recipient, xdaiWei: handle.xdaiWei }

  const transactionHash = (await options.provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: options.address,
        to: LOCAL_SOLVER_ADDRESS,
        value: `0x${(handle.token ? 0n : handle.amountSourceWei).toString(16)}`,
        data: encodeDeliveryInstruction(instruction),
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
    // A getter so the module has no top-level side effect: built eagerly, the
    // chain would read `localStorage` at import. `combineRails` snapshots the
    // array, so an edited endpoint lands on the next `resolvePaymentRail()`.
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

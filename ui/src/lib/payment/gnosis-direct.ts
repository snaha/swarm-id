// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Paying from Gnosis, where there is nothing to bridge.
 *
 * Every other source chain needs a rail to carry money to the batch-owner
 * address. Gnosis does not: the destination IS the source, so the wallet simply
 * sends xDAI to the owner and the operation continues from there — the same
 * SushiSwap swap and the same postage engine as any other route.
 *
 * It is also the one rail that is genuinely the same code locally: the local
 * chain answers as Gnosis, so a wallet pointed at it makes a real payment with
 * nothing standing in — no solver, no second chain, no invented prices.
 */
import { withTimeout } from '@snaha/swarm-id'
import { type SwapInput, gnosisMainnetSettings } from '@swarm-id/multichain'
import { type Chain, defineChain, encodeFunctionData, erc20Abi, formatUnits } from 'viem'

import {
  type ChainIdentity,
  chainIdentity,
  isGnosisMainnetGenesis,
  postageChain,
} from '$lib/payment/chain'
import { ownerGasCredit, withSwapBuffer } from '$lib/payment/funding'
import {
  type ExecutePaymentOptions,
  NATIVE_CURRENCY,
  type PaymentQuote,
  type PaymentRail,
  type PaymentToken,
  type QuoteRequest,
  displayAmount,
  displayUsd,
  walletGenesisHash,
} from '$lib/payment/payment-rail'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

export const GNOSIS_CHAIN_ID = 100
const XDAI_DECIMALS = 18

/** Confirming a transfer on a 5s-block chain; generous, but finite. */
const TRANSFER_TIMEOUT_MS = 120_000

/**
 * Long enough for a wallet to fetch one block, short enough that a wallet
 * which is never going to answer is treated as silent rather than left to hold
 * the Pay button. No prompt is involved — nobody is being waited on.
 */

/**
 * The two networks a wallet can be asked to switch to here, by the names it
 * shows them under. Shared with the refusals below on purpose: a message
 * telling someone to pick a network has to name the one they were offered.
 */
const GNOSIS_NAME = 'Gnosis Chain'
const FAKE_GNOSIS_NAME = 'Gnosis Chain (fake)'

/**
 * A shortfall that is only gas has nothing to pay in but xDAI: the gas leg is
 * native by definition, and there is no BZZ leg for a token to buy. Said in
 * words rather than sent to the Sushi quoter as a zero-amount trade, which
 * reverts and surfaces as a raw viem error under a dead Pay button.
 */
const GAS_ONLY_REFUSAL = 'This payment only covers transaction gas, which is paid in xDAI.'

/**
 * What the wait screen says while the wallet is asked for the second leg. The
 * progress card is already up by then, so the leg that just confirmed would
 * otherwise stay on screen while the wallet prompts for the next one.
 */
const APPROVE_TOKEN_LEG = 'Approve the payment in your wallet'

const XDAI: PaymentToken = {
  address: NATIVE_CURRENCY,
  symbol: 'xDAI',
  name: 'xDAI',
  decimals: XDAI_DECIMALS,
}

/** Decimals, per token, as their contracts report them. */
const WXDAI_DECIMALS = 18
const USDC_DECIMALS = 6
const BZZ_DECIMALS = 16

/**
 * What this rail accepts, and what each one becomes.
 *
 * Only assets with a real route to BZZ on Gnosis are here. Notably **not**
 * WETH: there is no BZZ/WETH pool at all, and the two-hop alternative runs
 * through pools holding a few hundred dollars between them, so offering it
 * would mean quoting trades that mostly cannot fill.
 *
 * Paying in BZZ skips the swap entirely: no slippage, and nothing to quote.
 */
const ACCEPTED: readonly { token: PaymentToken; input: SwapInput }[] = [
  { token: XDAI, input: 'xdai' },
  {
    token: {
      address: gnosisMainnetSettings().addresses.wxdai.toLowerCase(),
      symbol: 'WXDAI',
      name: 'Wrapped xDAI',
      decimals: WXDAI_DECIMALS,
    },
    input: 'wxdai',
  },
  {
    token: {
      address: gnosisMainnetSettings().addresses.usdc.toLowerCase(),
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: USDC_DECIMALS,
    },
    input: 'usdc',
  },
  {
    token: {
      address: gnosisMainnetSettings().addresses.bzz.toLowerCase(),
      symbol: 'BZZ',
      name: 'Swarm BZZ',
      decimals: BZZ_DECIMALS,
    },
    input: 'bzz',
  },
]

/** Which asset a picked `currency` is, or undefined when this rail has none. */
function acceptedFor(currency: string): (typeof ACCEPTED)[number] | undefined {
  return ACCEPTED.find((entry) => entry.token.address === currency.toLowerCase())
}

/**
 * The chain descriptor the wallet is asked to switch to.
 *
 * Built from the endpoint the app is actually pointed at, not from viem's
 * static `gnosis`, because off mainnet that endpoint is the local chain — which
 * answers as 100 on purpose. Naming it says which one a wallet is being sent
 * to, since the chain id cannot.
 */
function gnosisChain(identity: ChainIdentity): Chain {
  return defineChain({
    id: GNOSIS_CHAIN_ID,
    name: identity.kind === 'mainnet' ? GNOSIS_NAME : FAKE_GNOSIS_NAME,
    nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: XDAI_DECIMALS },
    rpcUrls: { default: { http: [networkSettingsStore.gnosisRpcUrl] } },
    // What `switchWalletChain` verifies the wallet against: two networks share
    // this chain id — the real Gnosis and the local chain wearing its id on
    // purpose — and only genesis says which one the wallet actually landed on.
    custom: { genesisHash: identity.genesisHash },
  })
}

/**
 * What `quote` hands `execute` — this rail's private payload.
 *
 * Two legs, because a payment made in a token cannot carry its own gas: the
 * owner key has to sign the swap and the postage calls afterwards, and a token
 * balance pays for neither. `gasXdaiWei` is that second leg, and it is zero
 * whenever the owner is already funded or the payment is in xDAI to begin with
 * (where one transfer covers both).
 */
interface DirectHandle {
  recipient: `0x${string}`
  /**
   * The BZZ leg: `amount` of `input`, `token` undefined for native xDAI.
   *
   * What the WALLET sends, which on a token leg is the quote's amount less
   * whatever of that token is already at the owner address — so zero is a
   * legitimate leg (an earlier transfer covered it), not a broken one. The
   * amount the swap spends is `delivers`.
   */
  input: SwapInput
  token: string
  amount: bigint
  /** The gas leg, always native xDAI, net of the xDAI already at the owner
   * address. Zero means nothing to send: one transfer, or none. */
  gasXdaiWei: bigint
}

function isDirectHandle(handle: unknown): handle is DirectHandle {
  const candidate = handle as DirectHandle | undefined
  return (
    typeof candidate?.recipient === 'string' &&
    typeof candidate.amount === 'bigint' &&
    typeof candidate.gasXdaiWei === 'bigint'
  )
}

/**
 * Price a direct payment: the user pays exactly what must arrive, because
 * nothing takes a cut in between. Gas is the wallet's own business and it
 * prices that itself.
 *
 * Paying in xDAI is one transfer and stays synchronous — there is no route to
 * shop for. Any other asset is sized against the pool it will be swapped
 * through, which is a chain read, and adds the gas leg alongside.
 *
 * Sizing from `bzzPlur` rather than converting `xdaiWei` into the token is the
 * point: the trade quoted here is the trade that runs, where a conversion
 * through xDAI would price a swap nobody makes and pay the spread twice.
 */
export async function quoteDirectPayment(request: QuoteRequest): Promise<PaymentQuote> {
  const accepted = acceptedFor(request.currency)
  if (!accepted) {
    throw new Error('That token cannot be paid with on Gnosis.')
  }
  const recipient = request.recipient as `0x${string}`

  if (accepted.input === 'xdai') {
    const amount = formatUnits(request.xdaiWei, XDAI_DECIMALS)
    return {
      handle: {
        recipient,
        input: 'xdai',
        token: NATIVE_CURRENCY,
        amount: request.xdaiWei,
        gasXdaiWei: 0n,
      },
      amountFormatted: displayAmount(amount),
      // xDAI is a dollar stablecoin, so the USD figure is the amount itself.
      amountUsd: displayUsd(amount),
      delivers: { input: 'xdai', amount: request.xdaiWei - request.gasXdaiWei },
    }
  }

  if (request.bzzPlur === 0n) {
    throw new Error(GAS_ONLY_REFUSAL)
  }

  // BZZ needs no pool at all: it is already what the operation spends — and so
  // takes no buffer either, since nothing about it can move. The swapped
  // tokens get the same 1.2× the xDAI leg gets: quoted exact-output here,
  // executed exact-input later at a fresher price, the difference between the
  // two is under-delivery discovered after the token has been spent. Exact-input
  // spends the headroom on more BZZ, where the next funds check consumes it.
  const chain = await postageChain()
  const amount =
    accepted.input === 'bzz'
      ? request.bzzPlur
      : withSwapBuffer(await chain.quoteTokenInForBzzOut(request.bzzPlur, accepted.input))

  // What is already at the owner address, in the very asset this leg is about
  // to ask for: a transfer that landed after its confirmation wait timed out.
  // Only the swapped tokens — the owner's BZZ is netted upstream, off the
  // operation's own need (`fundingShortfall`), so crediting it here as well
  // would take it off twice. Both legs are credited, because both can land on
  // their own: the swap spends the full `amount` either way, and only the
  // transfer that tops the address up to it is the user's to pay.
  const [stranded, gasCredit] = await Promise.all([
    accepted.input === 'bzz'
      ? Promise.resolve(0n)
      : chain.getTokenBalance(accepted.token.address as `0x${string}`, recipient),
    ownerGasCredit(request.recipient),
  ])
  const transfer = amount > stranded ? amount - stranded : 0n
  const gasXdaiWei = request.gasXdaiWei > gasCredit ? request.gasXdaiWei - gasCredit : 0n

  const formatted = formatUnits(transfer, accepted.token.decimals)
  const gasXdai = formatUnits(gasXdaiWei, XDAI_DECIMALS)
  return {
    handle: {
      recipient,
      input: accepted.input,
      token: accepted.token.address,
      amount: transfer,
      gasXdaiWei,
    },
    amountFormatted: displayAmount(formatted),
    // Only the dollar tokens price themselves; BZZ has no dollar figure here
    // and the screens render an empty one as absent rather than as free. The
    // gas leg is xDAI, which is a dollar too, and it is part of what the user
    // pays — a total that named only the token leg would be short of the bill.
    amountUsd:
      accepted.input === 'usdc' || accepted.input === 'wxdai'
        ? displayUsd(Number(formatted) + Number(gasXdai))
        : '',
    // The whole leg, not the transfer: what the swap must spend is everything
    // that will be at the owner address, and a credited residual is already
    // there. Sizing the swap from the transfer alone would leave the residual
    // stranded exactly as the retry that credited it was meant to prevent.
    delivers: { input: accepted.input, amount },
  }
}

/**
 * Whether this payment may be sent, given what the app's own endpoint is and
 * what the wallet says its genesis block is — or the reason to refuse, worded
 * for the person about to pay.
 *
 * Chain id cannot answer this. The local chain answers 100 deliberately, so a
 * wallet that already has REAL Gnosis configured satisfies a switch to 100
 * without ever being offered the local RPC, and the transfer that follows
 * moves REAL xDAI to an address whose key only this dev machine holds — while
 * the confirmation wait, which asks our own endpoint, runs out its two minutes
 * finding nothing. Genesis is the one thing a chain cannot borrow.
 *
 * A wallet that will not answer is refused unless the endpoint is PROVEN
 * mainnet. Fail closed, not open: on mainnet an unprovable wallet risks only a
 * payment that does not arrive, but off mainnet the same silence is exactly
 * what a real wallet pointed at real Gnosis looks like, and proceeding there
 * spends real money on a chain the app cannot see.
 *
 * The comparison is against the ENDPOINT's own genesis, not against "is either
 * of them mainnet": two chains that are both not mainnet are still two
 * different chains, and a wallet left on Ethereum matches a dev endpoint on
 * every question but that one.
 */
export function walletChainRefusal(
  endpoint: ChainIdentity,
  walletGenesisHash: string | undefined,
  rpcUrl: string,
): string | undefined {
  const endpointIsMainnet = endpoint.kind === 'mainnet'
  if (walletGenesisHash === undefined) {
    return endpointIsMainnet
      ? undefined
      : `Your wallet would not say which chain it is on, and this app is pointed at a test chain (${rpcUrl}) that answers as Gnosis. Rather than risk moving real xDAI, nothing was sent — switch your wallet to the ${FAKE_GNOSIS_NAME} network and try again.`
  }
  if (walletGenesisHash.toLowerCase() === endpoint.genesisHash.toLowerCase()) {
    return undefined
  }
  if (isGnosisMainnetGenesis(walletGenesisHash)) {
    return `Your wallet is on the real ${GNOSIS_NAME}, but this app is pointed at a test chain (${rpcUrl}) that answers as Gnosis too. Paying now would spend real xDAI on a payment this app can never see, so nothing was sent — switch your wallet to the ${FAKE_GNOSIS_NAME} network and try again.`
  }
  return endpointIsMainnet
    ? `Your wallet is on a test chain, but this app is pointed at the real ${GNOSIS_NAME} (${rpcUrl}). The payment would land where this app never looks, so nothing was sent — switch your wallet to ${GNOSIS_NAME} and try again.`
    : `Your wallet is on a different chain from the test chain this app is pointed at (${rpcUrl}). The payment would land where this app never looks, so nothing was sent — switch your wallet to the ${FAKE_GNOSIS_NAME} network and try again.`
}

/** Send the xDAI, and wait for it to confirm. */
async function executeDirectPayment(options: ExecutePaymentOptions): Promise<void> {
  const handle = options.quote.handle
  if (!isDirectHandle(handle)) {
    throw new Error('This payment was quoted by a different rail.')
  }

  // Before anything is signed: the wallet and this app must be on the same
  // chain, and only genesis can prove it.
  const identity = await chainIdentity()
  const refusal = walletChainRefusal(
    identity,
    await walletGenesisHash(options.provider),
    networkSettingsStore.gnosisRpcUrl,
  )
  if (refusal) {
    throw new Error(refusal)
  }

  const chain = await postageChain()

  /** Send one transaction and wait for it, naming the wait for the screens. */
  const send = async (
    request: { to: string; value?: bigint; data?: string },
    confirming: string,
  ): Promise<void> => {
    const transactionHash = (await options.provider.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from: options.address,
          to: request.to,
          ...(request.value === undefined ? {} : { value: `0x${request.value.toString(16)}` }),
          ...(request.data === undefined ? {} : { data: request.data }),
        },
      ],
    })) as string
    // Only now: the dialog swaps its "approve the payment in your wallet"
    // screen for the progress card on the first status, so an earlier one
    // would talk over the wallet's own prompt.
    options.onStatus?.(confirming)
    await withTimeout(
      chain.waitForTransactionSuccess(transactionHash as `0x${string}`),
      TRANSFER_TIMEOUT_MS,
      'The payment was sent but not confirmed in time. It may still land — reopen the drive to check.',
    )
  }

  // The gas leg first, and separately, because a token cannot pay for its own
  // swap. It goes FIRST so that a wallet rejection costs nothing: the token
  // leg is the larger of the two, and having it land with no gas behind it
  // would leave value parked at an address that cannot yet spend it. Skipped
  // entirely when zero, so the ordinary case is still one prompt.
  if (handle.gasXdaiWei > 0n) {
    await send(
      { to: handle.recipient, value: handle.gasXdaiWei },
      'Confirming the gas for your drive',
    )
  }

  if (handle.input === 'xdai') {
    await send({ to: handle.recipient, value: handle.amount }, 'Confirming your payment')
    return
  }

  // A zero-value ERC20 transfer costs gas and buys nothing. Here it means the
  // token the leg asks for is already at the owner address in full — an earlier
  // attempt's transfer, credited by the quote — so the payment is complete with
  // nothing sent, and the swap that follows spends what is there.
  if (handle.amount === 0n) {
    return
  }

  if (handle.gasXdaiWei > 0n) {
    options.onStatus?.(APPROVE_TOKEN_LEG)
  }

  await send(
    {
      to: handle.token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [handle.recipient, handle.amount],
      }),
    },
    'Confirming your payment',
  )
}

/**
 * The Gnosis rail for the endpoint currently configured, or undefined when that
 * endpoint cannot be identified — with no answer about which chain it is, we
 * cannot honestly name it to a wallet.
 */
export async function resolveGnosisDirectRail(): Promise<PaymentRail | undefined> {
  const identity = await chainIdentity().catch(() => undefined)
  if (identity === undefined || identity.kind === 'unsupported') {
    return undefined
  }
  const chain = gnosisChain(identity)
  return {
    chains: [chain],
    tokens: (chainId) => (chainId === GNOSIS_CHAIN_ID ? ACCEPTED.map((entry) => entry.token) : []),
    quote: quoteDirectPayment,
    execute: executeDirectPayment,
  }
}

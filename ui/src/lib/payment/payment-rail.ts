// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The payment rail seam: what carries the user's money from whatever chain
 * they hold funds on to native xDAI at the batch-owner address on Gnosis.
 *
 * Two rails serve it in production. Paying from Gnosis is not carried anywhere
 * at all — the destination is the source, so `gnosis-direct.ts` is a plain
 * transfer, in any of the assets that chain has a route to BZZ in. Every other
 * chain goes over Relay Protocol (`relay.ts`), an intent/solver network: the
 * user deposits on their own chain and an off-chain solver delivers on Gnosis
 * out of its own inventory.
 *
 * Relay cannot run locally — a local chain is invisible to a hosted quoting API
 * and to solvers paying out on real Gnosis — so the dev rail
 * (`$lib/dev/local-payment-rail`) stands in for it, taking a genuine signature
 * on a local source chain and having the baked faucet play the solver. The
 * direct rail needs no stand-in: it is the same code locally.
 *
 * Everything downstream of a rail is untouched production code: whatever was
 * delivered is swapped to BZZ by `swapDelivered` and spent by the postage
 * engine, on both rails alike.
 *
 * This module is deliberately a LEAF — it defines the contract and imports no
 * rail. Picking one lives in `resolve-rail.ts`, which may import them all; a
 * rail importing a value from here while this imported it back would be a
 * genuine initialisation cycle, and the type checker cannot see one.
 */
import { withTimeout } from '@snaha/swarm-id'
import type { SwapInput } from '@swarm-id/multichain'
import type { Chain } from 'viem'
import { arbitrum, base, gnosis, mainnet, optimism, polygon } from 'viem/chains'

/** Native-token sentinel for "the chain's own currency". */
export const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000'

/**
 * Every chain a rail may ask the wallet to sign on, in the order the picker
 * shows them.
 *
 * Lives here, in the leaf, because two unrelated modules need the same list and
 * neither may import the other: the Relay rail offers them, and `onboard.ts`
 * has to DECLARE them or web3-onboard reports the user's network as
 * unsupported the moment they switch to one.
 */
export const WALLET_CHAINS: Chain[] = [mainnet, base, arbitrum, optimism, polygon, gnosis]

/** A token the user can pay with on a given source chain. */
export interface PaymentToken {
  address: string
  symbol: string
  /** Full name, shown alongside the symbol as in the designs ("ETH (Ether)"). */
  name: string
  decimals: number
}

export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  /** EIP-1193 events — optional, since a minimal provider may not emit any. */
  on?(event: string, listener: (payload: unknown) => void): void
  removeListener?(event: string, listener: (payload: unknown) => void): void
}

export interface QuoteRequest {
  chainId: number
  currency: string
  /** The payer's address (their connected wallet). */
  user: string
  /** The batch-owner address the money must land on. */
  recipient: string
  /** Exact xDAI (wei) that must arrive on Gnosis, gas included. */
  xdaiWei: bigint
  /**
   * The BZZ the operation needs. A rail paid in something other than xDAI
   * sizes its leg from this rather than from `xdaiWei`, so the trade it prices
   * is the one that will actually run — converting through xDAI first would
   * quote a swap nobody makes and lose the difference twice.
   */
  bzzPlur: bigint
  /**
   * The part of `xdaiWei` that is gas. It has to arrive AS xDAI whatever pays
   * for the rest: the owner key signs the swap and the postage calls, and a
   * token balance cannot pay for either.
   */
  gasXdaiWei: bigint
}

/** Significant digits in a displayed price. */
const AMOUNT_PRECISION_DIGITS = 4
const USD_DECIMALS = 2
/** The dollar figure below which cents are all zeros. */
const CENT = 0.01
/** Significant digits for a sub-cent dollar figure. */
const SUB_CENT_DIGITS = 2

/**
 * `amount` at `digits` significant figures, spelled out in full.
 *
 * `toPrecision` is what this is not. It reaches for exponential notation
 * outside a narrow middle band — at four significant digits, from 10000 up and
 * below 1e-7 — and these figures are rendered verbatim beside a token symbol,
 * where "1.235e+4" is not a price anyone can read and the exponent invites
 * being read as part of the amount. `toLocaleString` spells the same rounding
 * out instead, and pads no trailing zeros back on ("0.0005", not "0.00050") —
 * padding is not precision, and it reads as a different figure beside a
 * rounded one.
 *
 * The locale is pinned rather than the user's: this is a machine-shaped money
 * figure that the screens put next to a symbol and, in the breakdown rows,
 * beside amounts formatted from wei. A comma for a decimal point would change
 * what it says.
 */
function significantDigits(amount: number, digits: number): string {
  return amount.toLocaleString('en-US', { maximumSignificantDigits: digits, useGrouping: false })
}

/**
 * A source-token price as the screens show it: a few significant digits, no
 * trailing zeros.
 *
 * Normalising here rather than trusting each rail is the point. Rails hand back
 * wildly different precision — Relay's `amountFormatted` carries the full wei
 * expansion (`0.000043465998997394` for a native token), the dev rail derives
 * its own — and the pay screen puts this figure directly above breakdown rows
 * that ARE rounded. Eighteen decimals over four reads as a different product
 * depending on which rail happens to be behind it.
 */
export function displayAmount(value: string | number): string {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) {
    return ''
  }
  return significantDigits(amount, AMOUNT_PRECISION_DIGITS)
}

/**
 * A dollar figure as the screens show it: cents normally, significant digits
 * below a cent. The one USD formatter in the app — the pay screen's total and
 * the drive dialogs' cost estimate both come through here, so the two cannot
 * drift into rendering the same money differently.
 *
 * Empty for anything that is not a positive number, INCLUDING zero: every
 * caller renders this behind a truthiness check, and a figure that could not be
 * priced must read as absent, not as free — returning `'0.00'` for a quote
 * missing its `currencyIn` would render "~0.00 USD total" under a blank cost
 * line.
 *
 * Sub-cent is not a rounding artefact either — extending a small drive genuinely
 * costs a fraction of a cent, and "0.00 USD" would read as free rather than as
 * cheap.
 */
export function displayUsd(value: string | number): string {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) {
    return ''
  }
  return amount < CENT ? significantDigits(amount, SUB_CENT_DIGITS) : amount.toFixed(USD_DECIMALS)
}

/** What a payment leaves at the batch-owner address, for the swap that follows. */
export interface Delivery {
  /** Which asset — `bzz` means the operation is already funded and no swap runs. */
  input: SwapInput
  /**
   * How much of it the operation settles from, in that asset's own units — the
   * full leg, including any residual already at the owner address that the
   * rail credited rather than transferred.
   *
   * Asymmetric on purpose, and only the token legs are settled from it. A
   * token leg is swapped whole, so this IS the figure to swap. Native xDAI is
   * not: the caller's swap input also contains whatever xDAI was already
   * parked at the owner address, which the rail never carried and cannot see —
   * so `settleWith` (`funding.ts`) keeps the caller's figure there and reads
   * only `input`. Sizing the swap from what the rail delivered would leave that
   * residual unswapped, one buffer short of what the operation needs.
   */
  amount: bigint
}

export interface PaymentQuote {
  /**
   * Rail-private payload, consumed only by the rail that produced it — Relay
   * keeps its SDK `Execute` here, the dev rail its own record. Opaque so a
   * second rail can exist at all — and it must reach `execute` exactly as
   * produced: hold the quote in `$state.raw`, never deep-reactive state, since
   * a proxy-wrapped handle cannot be structured-cloned and Relay's SDK clones
   * its quote before walking the steps.
   */
  handle: unknown
  /**
   * Source-token amount the user pays, DISPLAY-READY (e.g. "0.00000872").
   * Produce it with {@link displayAmount} — a rail's own figure is not it.
   */
  amountFormatted: string
  /** USD value of the payment, display-ready (e.g. "0.17") — {@link displayUsd}. */
  amountUsd: string
  /**
   * What lands at the owner address for the BZZ leg, which decides the swap
   * that follows. Stated by the rail rather than inferred, because only the
   * rail knows what it actually sent — and the swap spending the wrong asset
   * fails at the far end of a payment that already succeeded.
   */
  delivers: Delivery
}

export interface ExecutePaymentOptions {
  quote: PaymentQuote
  provider: EthereumProvider
  chainId: number
  /**
   * The token being paid with, as its {@link PaymentToken} address. Carried
   * even though no rail reads it, because the combined rail dispatches on it:
   * one chain can be served by two rails, split by token.
   */
  currency: string
  /** The payer's address (their connected wallet). */
  address: string
  /**
   * Receives the rail's current step so the pending screen can name what is
   * happening (e.g. the design's "Cross-swap xDAI on Relay").
   */
  onStatus?: (status: string) => void
}

export interface PaymentRail {
  /** Source chains this rail offers, in the order the picker shows them. */
  chains: Chain[]
  /** What the user may pay with on `chainId` — empty for a chain it does not serve. */
  tokens(chainId: number): PaymentToken[]
  /** Price a payment that delivers exactly `xdaiWei` to `recipient` on Gnosis. */
  quote(request: QuoteRequest): Promise<PaymentQuote>
  /** Take the payment and see it through to delivery. */
  execute(options: ExecutePaymentOptions): Promise<void>
}

/** EIP-1193: the wallet has no such chain configured. */
const CHAIN_NOT_ADDED = 4902
/** EIP-1193: the user said no. */
const USER_REJECTED = 4001

/**
 * The wording left when the code is gone. Conservative on purpose — it decides
 * whether the app follows a failed switch with a second wallet prompt, so it
 * matches how wallets name this failure ("Unrecognized chain ID", "chain has
 * not been added") and nothing vaguer. Anchored: an unrelated message that
 * happens to contain the digits "4902" (a bigger chain id, a gas figure, an
 * address fragment) or an unrelated "not ... added" pairing must not trigger
 * an unrequested wallet_addEthereumChain prompt.
 */
const UNRECOGNIZED_CHAIN_MESSAGE = /unrecognized chain|chain (?:has )?not been added|\b4902\b/i

/** The shapes a provider error is found in — all optional, none guaranteed. */
interface ProviderError {
  code?: unknown
  message?: unknown
  /** Some relays nest the provider's own error here, one or two levels down. */
  data?: { code?: unknown; originalError?: { code?: unknown } }
}

/**
 * Whether a failed `wallet_switchEthereumChain` means "I have no such chain" —
 * the one failure worth answering with an add-network prompt.
 *
 * A browser extension answers EIP-1193's 4902 at the top level and nothing
 * else needs looking at. Anything relaying for one does not: MetaMask over
 * WalletConnect and several in-app wallets wrap the provider's answer in a
 * generic -32603 and keep the real code at `data.originalError.code` or
 * `data.code`, or lose it entirely and leave only the message.
 *
 * A user's own "no" is never a missing chain, wherever in that nesting it
 * turns up: re-prompting them to add a network would be the app arguing with a
 * decision they just made.
 */
export function isUnrecognizedChainError(error: unknown): boolean {
  const candidate = error as ProviderError | undefined
  const codes = [candidate?.code, candidate?.data?.code, candidate?.data?.originalError?.code]
  if (codes.includes(USER_REJECTED)) {
    return false
  }
  if (codes.includes(CHAIN_NOT_ADDED)) {
    return true
  }
  return (
    typeof candidate?.message === 'string' && UNRECOGNIZED_CHAIN_MESSAGE.test(candidate.message)
  )
}

const GENESIS_PROBE_TIMEOUT_MS = 10_000

/**
 * The genesis block as the WALLET reports it. Asked through the wallet's own
 * provider deliberately: it answers for whatever chain the wallet is really
 * on, which is the only thing that can contradict the chain it was asked to
 * switch to.
 *
 * @returns undefined when the wallet will not or cannot say — a refusal to
 *   answer is not evidence of anything, and each caller decides what that
 *   silence costs.
 */
export async function walletGenesisHash(provider: EthereumProvider): Promise<string | undefined> {
  const block = await withTimeout(
    provider.request({ method: 'eth_getBlockByNumber', params: ['0x0', false] }),
    GENESIS_PROBE_TIMEOUT_MS,
    'The wallet did not say which chain it is on.',
  ).catch(() => undefined)
  const hash = (block as { hash?: unknown } | undefined)?.hash
  return typeof hash === 'string' ? hash : undefined
}

/**
 * Ask the wallet to switch to `chainId`, adding the chain when the wallet does
 * not know it. Rejects if the user declines — the caller shows the design's
 * "unconfirmed chain change" state while this is pending.
 *
 * A chain carrying `custom.genesisHash` — the fake Gnosis, wearing mainnet's
 * chain id on purpose — is verified after the switch, because the id alone
 * cannot land the wallet on the right network: a wallet that has REAL Gnosis
 * configured satisfies a switch to 100 without ever seeing the local RPC. On a
 * proven mismatch the chain is offered again through `wallet_addEthereumChain`,
 * which is the one request that makes a wallet adopt OUR endpoint for an id it
 * already serves — MetaMask prompts to update the network and flips its active
 * RPC. A wallet that stays put after that is refused in words.
 */
export async function switchWalletChain(
  provider: EthereumProvider,
  chainId: number,
  chains: Chain[],
): Promise<void> {
  const hexChainId = `0x${chainId.toString(16)}`
  const chain = chains.find((candidate) => candidate.id === chainId)

  // Rebuilt field by field rather than passed through. A wallet's arguments
  // cross a postMessage bridge and are structured-cloned, so handing over a
  // reference to someone else's object means whatever it happens to be —
  // a framework proxy, a class instance — decides whether the payment works.
  // Copying the primitives out makes that impossible to get wrong.
  const offerChain = (target: Chain) =>
    provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexChainId,
          chainName: target.name,
          nativeCurrency: {
            name: target.nativeCurrency.name,
            symbol: target.nativeCurrency.symbol,
            decimals: target.nativeCurrency.decimals,
          },
          rpcUrls: [...target.rpcUrls.default.http],
        },
      ],
    })

  const switchChain = () =>
    provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    })

  try {
    await switchChain()
  } catch (error) {
    if (!isUnrecognizedChainError(error) || !chain) {
      throw error
    }
    await offerChain(chain)
    // Adding is not switching. Some wallets bundle the two into one prompt,
    // several do not — and there the payment would be signed on whatever network
    // the wallet was on before, which the local and the real Gnosis both answer
    // to as chain id 100. Ask again; a refusal fails the same way a refused
    // switch does.
    await switchChain()
  }

  const expected = chain?.custom?.genesisHash
  if (typeof expected !== 'string' || !chain) {
    return
  }
  const reported = await walletGenesisHash(provider)
  // Silence is not a mismatch: a wallet that will not answer is judged at pay
  // time (`walletChainRefusal`), where mainnet and dev earn different verdicts.
  if (reported === undefined || reported.toLowerCase() === expected.toLowerCase()) {
    return
  }
  // The offer itself can be refused — MetaMask rejects an id it already
  // serves with "network already exists" rather than adopting the RPC — and
  // that refusal must land as the worded verdict below, not as a wallet's
  // internals quoted at the user.
  await offerChain(chain).catch(() => undefined)
  const repaired = await walletGenesisHash(provider)
  if (repaired !== undefined && repaired.toLowerCase() === expected.toLowerCase()) {
    return
  }
  throw new Error(
    `The wallet stayed on a different network that also answers as chain ${chainId} and would not adopt ${chain.rpcUrls.default.http[0]} for it. Remove that network from the wallet — or select this RPC in its network menu — and try again.`,
  )
}

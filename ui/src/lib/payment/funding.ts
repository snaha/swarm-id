// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Turning a funding need into money at the batch-owner address.
 *
 * Quote how much xDAI buys the missing BZZ on SushiSwap, add the gas, have the
 * rail deliver that xDAI to the owner, then swap it to BZZ with the owner key.
 *
 * The swap leg is the same wherever the money came from: the local chain
 * carries a real BZZ market at the mainnet addresses, so only the delivery is
 * the rail's business — see `payment-rail.ts`.
 */
import { withTimeout } from '@snaha/swarm-id'
import type { SwapInput } from '@swarm-id/multichain'

import { prefix0x } from '$lib/crypto/hex'
import { postageChain } from '$lib/payment/chain'
import type { FundingNeed } from '$lib/payment/drive-operation'
import type { Delivery } from '$lib/payment/payment-rail'
import { GAS_BUDGET_XDAI_WEI } from '$lib/payment/postage-onchain'
import { derivePostageSigner } from '$lib/payment/purchase'

/** Swap slippage/rounding headroom on the quoted xDAI, as the widget uses.
 * The swap executes exact-INPUT, so the headroom is spent buying BZZ rather
 * than left over: the surplus lands as BZZ at the owner address, where the
 * next operation's funds check consumes it before asking for more. */
const SWAP_BUFFER_NUMERATOR = 12n
const SWAP_BUFFER_DENOMINATOR = 10n

/**
 * The headroom applied to every leg that ends in a swap, wherever it is sized.
 *
 * Exported so the rails size their own token legs through it rather than
 * carrying a second copy of the number: a token leg quoted exact-output and
 * then swapped exact-input at a later, fresher price under-delivers on any
 * adverse move, and the shortfall surfaces only after the token has been spent.
 */
export function withSwapBuffer(amount: bigint): bigint {
  return (amount * SWAP_BUFFER_NUMERATOR) / SWAP_BUFFER_DENOMINATOR
}

/** Price impact above which we refuse to swap — BZZ pools on Gnosis are thin
 * (~$10k total), and a large resize can move the price hard. */
const MAX_PRICE_IMPACT_PERCENT = 5n
const PERCENT = 100n

/**
 * Why this trade may not be swapped, or undefined when it may.
 *
 * The judgement is the swap's, not the payment's, which is why it is a function
 * the pay screen calls once the token is known rather than a throw from
 * `quoteFunding`. Paying in BZZ touches no pool at all — refusing that for a
 * price the payment never pays would leave the one user who could afford a big
 * resize unable to make it.
 */
export function priceImpactRefusal(impactPercent: bigint): string | undefined {
  return impactPercent > MAX_PRICE_IMPACT_PERCENT
    ? `This amount would move the BZZ price by about ${impactPercent}%. Try a smaller change, or pay in BZZ.`
    : undefined
}

/**
 * Reference trade sizing the near-spot price: small enough that its own impact
 * is negligible (measured at ~0% against both BZZ pools), large enough not to
 * be lost to rounding.
 *
 * One whole BZZ rather than a dust amount, because the swap may be routed
 * through USDC and USDC carries six decimals: 0.0001 BZZ is a fraction of a
 * cent, which rounds to zero USDC units mid-route and prices the reference off
 * a trade that could not happen. A reference priced through a different pool
 * than the real trade turns this comparison into a measure of the spread
 * between two pools rather than of one trade's own impact.
 */
const IMPACT_REFERENCE_BZZ_PLUR = 10_000_000_000_000_000n // 1 BZZ

const SWAP_TIMEOUT_MS = 120_000

/**
 * The swap's own gas, which the delivery has to carry on top of everything
 * else.
 *
 * `swapDelivered` is signed by the owner key and pays for itself out of the
 * owner's balance — and it runs BEFORE the postage operations that
 * `GAS_BUDGET_XDAI_WEI` covers. Size the delivery without it and the swap
 * spends the operating budget back down, so the funds check that re-runs
 * immediately afterwards finds the owner short and rejects a payment that in
 * fact succeeded. Generous against a Gnosis swap's real cost (~0.0003 xDAI),
 * because the whole point is that this is never the binding constraint.
 */
export const SWAP_GAS_XDAI_WEI = 2_000_000_000_000_000n // 0.002 xDAI

/** What the user must pay for, in Gnosis-side terms. */
export interface FundingQuote {
  /**
   * Total xDAI (wei) the rail must deliver: swap input + gas, LESS whatever is
   * already sitting at the owner address. Zero means the operation is already
   * covered and the payment screens never open.
   */
  xdaiWei: bigint
  /** The xDAI portion that buys BZZ (the "value" line in the breakdown). */
  xdaiForBzzWei: bigint
  /** The xDAI portion kept for gas — the operation's budget shortfall plus the
   * swap's own gas, since the user pays for both (the breakdown's "gas" line). */
  xdaiForGasWei: bigint
  /** BZZ (PLUR) the swap must deliver. */
  bzzPlur: bigint
  /**
   * How far this trade would move the BZZ pool, in percent — 0 when no swap is
   * priced at all. Carried rather than acted on here: only the pay screen knows
   * which token was picked, and a payment made in BZZ runs no swap and so pays
   * none of this ({@link priceImpactRefusal}).
   */
  priceImpactPercent: bigint
  /**
   * What the swap must spend at the owner address, and how much of it.
   *
   * Defaulted to the xDAI figures because that is what a rail delivers unless
   * the user paid in something else; a payment made in a token settles through
   * {@link settleWith}, which is where the asymmetry between the two is spelled
   * out. The swap below spends exactly this, so a quote that lies here spends
   * the wrong asset — or the wrong amount — at the far end of a payment that
   * already succeeded.
   */
  paidWith: SwapInput
  paidAmount: bigint
}

/**
 * How much worse than the near-spot rate this trade fills, in percent —
 * the pool's price impact for a trade this size. Compared against a small
 * reference trade rather than a spot oracle, which the pool does not expose.
 */
function priceImpactPercent(
  referenceIn: bigint,
  referenceOut: bigint,
  actualIn: bigint,
  actualOut: bigint,
): bigint {
  // Cross-multiplied rates avoid dividing bigints down to zero.
  const referenceRate = referenceIn * actualOut
  const actualRate = actualIn * referenceOut
  if (actualRate <= referenceRate) {
    return 0n
  }
  return ((actualRate - referenceRate) * PERCENT) / referenceRate
}

/**
 * Size the xDAI that must arrive on Gnosis to satisfy `need`: an exact-output
 * Sushi quote for the missing BZZ (plus buffer), plus the gas the owner address
 * is genuinely still missing, less whatever it already holds above the budget.
 *
 * The gas term is derived from a LIVE balance read rather than from
 * `need.xdai`. The need is captured once, before the first payment screen
 * opens, and every re-price after a failed attempt reuses it — so a gas leg
 * that landed and then failed to swap would be charged for again, on top of the
 * surplus the same read is already crediting.
 *
 * @throws when the swap route cannot be priced (no liquidity, RPC down).
 */
export async function quoteFunding(need: FundingNeed): Promise<FundingQuote> {
  const client = await postageChain()
  let xdaiForBzzWei = 0n
  let impact = 0n
  if (need.bzz > 0n) {
    const [quoted, reference] = await Promise.all([
      client.quoteXdaiInForBzzOut(need.bzz),
      client.quoteXdaiInForBzzOut(IMPACT_REFERENCE_BZZ_PLUR),
    ])
    impact = priceImpactPercent(reference, IMPACT_REFERENCE_BZZ_PLUR, quoted, need.bzz)
    xdaiForBzzWei = withSwapBuffer(quoted)
  }
  // One read, two answers, and they are the same figure seen from either side:
  // below the budget it is a shortfall the rail must cover, above it a surplus
  // that pays for this operation before the rail does. Whichever it is, it is
  // the owner address's xDAI right now — the residual of an earlier attempt
  // included, which is the user's money sitting exactly where the swap spends
  // from.
  const ownerXdai = await client.getNativeBalance(prefix0x(need.destination) as `0x${string}`)
  const gasShortfall = ownerXdai >= GAS_BUDGET_XDAI_WEI ? 0n : GAS_BUDGET_XDAI_WEI - ownerXdai
  const surplus = ownerXdai > GAS_BUDGET_XDAI_WEI ? ownerXdai - GAS_BUDGET_XDAI_WEI : 0n
  // The swap's own gas only when a swap will actually run — a gas-only
  // shortfall is delivered and spent directly, with nothing in between (and
  // asking the rail to deliver an allowance nobody spends would be the user's
  // money).
  const xdaiForGasWei = gasShortfall + (xdaiForBzzWei > 0n ? SWAP_GAS_XDAI_WEI : 0n)
  const required = xdaiForBzzWei + xdaiForGasWei
  return {
    xdaiWei: required > surplus ? required - surplus : 0n,
    xdaiForBzzWei,
    xdaiForGasWei,
    bzzPlur: need.bzz,
    priceImpactPercent: impact,
    paidWith: 'xdai',
    paidAmount: xdaiForBzzWei,
  }
}

/**
 * The quote the swap will spend, given what the rail says it carried.
 *
 * A token leg is swapped whole, so the rail's own figure is the one to use —
 * only it knows how much of that token actually moved. Native xDAI is the
 * exception: the swap input also contains the surplus already parked at the
 * owner address, which the rail neither carried nor can see, so the quote's own
 * figure stands. Settling that side from the delivery would swap one buffer
 * less than the operation needs, and — in the window where the surplus exceeds
 * the swap input — a negative amount.
 */
export function settleWith(quote: FundingQuote, delivery: Delivery): FundingQuote {
  if (delivery.input === 'xdai') {
    return quote
  }
  return { ...quote, paidWith: delivery.input, paidAmount: delivery.amount }
}

/**
 * Turn whatever landed at the owner address into the BZZ the operation needs.
 * Signed by the owner key; skipped when no BZZ is required (a gas-only
 * shortfall) — and when the payment was made in BZZ, which is already the
 * asset the operation spends and so has nothing to trade.
 */
export async function swapDelivered(derivationKey: string, quote: FundingQuote): Promise<void> {
  if (quote.bzzPlur === 0n || quote.paidAmount === 0n || quote.paidWith === 'bzz') {
    return
  }
  const client = await postageChain()
  const { signerKey, destination } = await derivePostageSigner(derivationKey)
  const originPrivateKey = prefix0x(signerKey.toHex()) as `0x${string}`
  const recipient = prefix0x(destination) as `0x${string}`
  const hash =
    quote.paidWith === 'xdai'
      ? await client.swapXdaiToBzz({
          originPrivateKey,
          amountXdai: quote.paidAmount,
          recipient,
        })
      : await client.swapTokenToBzz({
          originPrivateKey,
          input: quote.paidWith,
          amount: quote.paidAmount,
          recipient,
        })
  await withTimeout(
    client.waitForTransactionSuccess(hash),
    SWAP_TIMEOUT_MS,
    'The BZZ swap was not confirmed in time.',
  )
}

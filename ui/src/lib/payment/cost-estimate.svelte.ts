// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The drive dialogs' shared cost estimate: what an operation will cost, in
 * dollars where the pool can price it and in BZZ where it cannot.
 *
 * One implementation for all three dialogs (add, extend, resize). Each still
 * supplies its own cost: a purchase spreads the per-chunk amount over the new
 * depth, an extend over the drive's current one.
 *
 * Dollars are what the designs show, priced through the same SushiSwap pool the
 * payment actually buys BZZ from — so the form agrees with the pay screen it
 * leads to instead of introducing a second notion of price. BZZ is the
 * fallback, not the intent: it needs only the storage price, so it survives a
 * pool the RPC cannot quote.
 */
import { currentBzzXdaiRate, usdForPlur } from '$lib/payment/bzz-price'
import { withSwapBuffer } from '$lib/payment/funding'
import { stampCostBzz } from '$lib/payment/purchase'

/** What is being priced: `amountPerChunk` PLUR, spread over `depth`. */
export interface EstimatedCost {
  depth: number
  amountPerChunk: bigint
}

/**
 * `cost` in dollars, as the pay screen will ask for it — empty when the pool
 * rate is unknown or there is nothing to price.
 *
 * Invariant: this equals `quoteFunding`'s BZZ leg for the same batch. Both
 * price the same trade through the same pool and both carry
 * {@link withSwapBuffer}, so the form and the screen it leads to cannot differ
 * by the buffer — a 20% jump between one and the next reads as a price that
 * moved while the user was deciding. The buffer is applied to the BZZ rather
 * than to the xDAI it converts to, which is the same figure: the conversion is
 * a multiplication.
 *
 * Gas is the one part left out. It is a live balance read at the owner address
 * — a form re-deriving this on every keystroke cannot make it — and a fraction
 * of a cent beside the storage cost.
 */
export function estimatedUsd(cost: EstimatedCost, rateXdaiWei: bigint | undefined): string {
  if (rateXdaiWei === undefined) {
    return ''
  }
  return usdForPlur(withSwapBuffer(cost.amountPerChunk << BigInt(cost.depth)), rateXdaiWei)
}

export interface CostEstimate {
  /**
   * The figure with its unit ("7.05 USD", "187.5 BZZ"), or undefined when there
   * is nothing to price yet. Callers add their own "~" or "≈".
   */
  readonly value: string | undefined
}

/**
 * Track the estimate for whatever `cost` currently describes.
 *
 * Call at component top level — it registers an `$effect` for the rate fetch,
 * which is best-effort: a miss only falls back to BZZ, so nothing surfaces the
 * failure.
 */
export function createCostEstimate(cost: () => EstimatedCost | undefined): CostEstimate {
  let rate = $state<bigint | undefined>(undefined)
  $effect(() => {
    currentBzzXdaiRate()
      .then((quoted) => (rate = quoted))
      .catch(() => undefined)
  })

  const value = $derived.by(() => {
    const priced = cost()
    if (!priced) {
      return undefined
    }
    const usd = estimatedUsd(priced, rate)
    if (usd) {
      return `${usd} USD`
    }
    const bzz = stampCostBzz(priced.depth, priced.amountPerChunk)
    return bzz ? `${bzz} BZZ` : undefined
  })

  return {
    get value() {
      return value
    },
  }
}

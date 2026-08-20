// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The drive dialogs' shared cost estimate: what an operation will cost, in
 * dollars where the pool can price it and in BZZ where it cannot.
 *
 * ONE definition, shared by all three dialogs (add, extend, resize) and the pay
 * screen: same rate fetch, same fallback, so they cannot disagree about how the
 * same money reads. Each still supplies its own cost: a purchase spreads the
 * per-chunk amount over the new depth, an extend over the drive's current one.
 *
 * Dollars are what the designs show, priced through the same SushiSwap pool the
 * payment actually buys BZZ from — so the form agrees with the pay screen it
 * leads to instead of introducing a second notion of price. BZZ is the
 * fallback, not the intent: it needs only the storage price, so it survives a
 * pool the RPC cannot quote.
 */
import { currentBzzXdaiRate, usdForPlur } from '$lib/payment/bzz-price'
import { stampCostBzz } from '$lib/payment/purchase'

/** What is being priced: `amountPerChunk` PLUR, spread over `depth`. */
export interface EstimatedCost {
  depth: number
  amountPerChunk: bigint
}

export interface CostEstimate {
  /**
   * The figure with its unit ("7.05 USD", "187.5 xBZZ"), or undefined when
   * there is nothing to price yet. Callers add their own "~".
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
  // Re-runs when the configured endpoint changes (the fetch reads it before
  // its first await). Cleared first: a rate from the previous endpoint must
  // not survive into this one — not while the new read is in flight, and not
  // when it fails (see chain-cache.ts) — so a miss falls back to BZZ.
  $effect(() => {
    rate = undefined
    currentBzzXdaiRate()
      .then((quoted) => (rate = quoted))
      .catch(() => undefined)
  })

  const value = $derived.by(() => {
    const priced = cost()
    if (!priced) {
      return undefined
    }
    const usd =
      rate === undefined ? '' : usdForPlur(priced.amountPerChunk << BigInt(priced.depth), rate)
    if (usd) {
      return `${usd} USD`
    }
    const bzz = stampCostBzz(priced.depth, priced.amountPerChunk)
    // "xBZZ", as the pay screen prices the same money — the Gnosis token is
    // what is actually spent, and two names for it read as two currencies.
    return bzz ? `${bzz} xBZZ` : undefined
  })

  return {
    get value() {
      return value
    },
  }
}

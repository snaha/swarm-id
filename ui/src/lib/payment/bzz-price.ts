// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * What BZZ is worth, in dollars, for the drive dialogs' cost estimates.
 *
 * There is no price oracle here and no third-party feed: the same SushiSwap
 * pool the funding flow actually buys through is asked what BZZ costs in xDAI,
 * and xDAI — a dollar stablecoin — is taken as the dollar, as the pay screen's
 * own rail does (`gnosis-direct.ts`), so the forms agree with the screen they
 * lead to.
 *
 * A RATE is cached, not a quote. `quoteExactOutputSingle` is a contract
 * simulation, and the extend dialog re-derives its estimate on every keystroke
 * — quoting the exact amount each time would put an RPC round-trip behind the
 * number keys. So one reference trade is priced per minute and the caller
 * multiplies locally, exactly as `chain-price.ts` does with the storage price.
 *
 * The cost of that: a reference trade sits near spot, so it does not carry the
 * price impact of the user's actual (larger) trade, and the estimate reads
 * slightly low for big resizes. Bounded rather than unbounded — `quoteFunding`
 * refuses anything above `MAX_PRICE_IMPACT_PERCENT`, so the figure the user
 * eventually pays cannot be more than that off this one, and the estimate is
 * prefixed "~" on every screen that shows it.
 */
import { formatUnits } from 'viem'

import { postageChain } from '$lib/payment/chain'
import { cachedChainRead } from '$lib/payment/chain-cache'
import { displayUsd } from '$lib/payment/payment-rail'

/** 1 BZZ, the trade the rate is quoted from. Large enough that the quote is
 * not lost to integer rounding, small enough to sit near spot in a pool this
 * thin (~$10k total). */
const REFERENCE_BZZ_PLUR = 10n ** 16n

const XDAI_DECIMALS = 18

/** Matches `chain-price.ts` — the pool moves, but not within a dialog. */
const RATE_TTL_MS = 60_000

/**
 * xDAI (wei) that buys {@link REFERENCE_BZZ_PLUR} of BZZ right now — the rate
 * {@link usdForPlur} converts with.
 *
 * @throws when the pool cannot be quoted (RPC down, or a chain carrying no BZZ
 *   market). Callers fall back to showing the BZZ figure; a failure is never
 *   cached, so the next dialog open retries.
 */
export const currentBzzXdaiRate = cachedChainRead(RATE_TTL_MS, async (url) => {
  const xdaiWei = await (await postageChain(url)).quoteXdaiInForBzzOut(REFERENCE_BZZ_PLUR)
  if (xdaiWei <= 0n) {
    throw new Error('The BZZ pool returned no price.')
  }
  return xdaiWei
})

/**
 * `plur` of BZZ priced in dollars at `rateXdaiWei`, formatted as the screens
 * show it — empty when there is nothing to price.
 *
 * Formatting goes through the rails' `displayUsd`, deliberately: this figure
 * and the pay screen's total are the same money one step apart, and a dialog
 * that rounded differently from the screen it leads to would read as a price
 * that moved on the way.
 *
 * Cross-multiplied before dividing, so a small amount does not floor to zero.
 */
export function usdForPlur(plur: bigint, rateXdaiWei: bigint): string {
  if (plur <= 0n || rateXdaiWei <= 0n) {
    return ''
  }
  return displayUsd(formatUnits((plur * rateXdaiWei) / REFERENCE_BZZ_PLUR, XDAI_DECIMALS))
}

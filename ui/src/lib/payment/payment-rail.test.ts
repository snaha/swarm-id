// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'

import { displayAmount, displayUsd } from '$lib/payment/payment-rail'

/**
 * The two figures the pay screen stacks on top of each other, and the same
 * `displayUsd` the drive dialogs price their estimate with. Rails hand back
 * wildly different precision, so what they render is decided here, not there.
 */
describe('displayAmount', () => {
  it('cuts a rail’s raw precision down to significant digits', () => {
    // Relay's `amountFormatted` for a native token, verbatim.
    expect(displayAmount('0.000043465998997394')).toBe('0.00004347')
  })

  it('drops the zeros toPrecision pads back on', () => {
    expect(displayAmount('1.5')).toBe('1.5')
    expect(displayAmount(2)).toBe('2')
  })

  /**
   * Padding is only ever after a decimal point. The pay screen carried its own
   * copy of this trim that had lost that distinction, so a four-significant-
   * digit integer lost its REAL zeros and 1230 rendered as 123 — an order of
   * magnitude off, in a figure the user is about to pay.
   */
  it('keeps the zeros that are part of the number', () => {
    expect(displayAmount(1230)).toBe('1230')
    expect(displayAmount(1000)).toBe('1000')
    expect(displayAmount(9990)).toBe('9990')
  })

  it('has nothing to show for a non-figure or a non-positive one', () => {
    expect(displayAmount('')).toBe('')
    expect(displayAmount('nonsense')).toBe('')
    expect(displayAmount(0)).toBe('')
    expect(displayAmount(-1)).toBe('')
  })
})

describe('displayUsd', () => {
  it('shows cents for ordinary figures', () => {
    expect(displayUsd(1.5852)).toBe('1.59')
    expect(displayUsd('0.17')).toBe('0.17')
    expect(displayUsd(7.048359592682033)).toBe('7.05')
  })

  /**
   * A small drive genuinely costs a fraction of a cent to extend, so cents
   * alone would render a real price as "0.00" — free, rather than cheap.
   */
  it('shows significant digits below a cent', () => {
    expect(displayUsd(0.0034)).toBe('0.0034')
    expect(displayUsd(0.00012)).toBe('0.00012')
    expect(displayUsd(0.0005)).toBe('0.0005')
  })

  /**
   * The defect this closes: Relay's `currencyIn` is optional, so `relay.ts`
   * passes `''` when a quote arrives without it. Formatting that as '0.00' put
   * "~0.00 USD total" under a blank cost line — a priced-at-nothing payment.
   * Empty instead, which every caller already renders behind a truthiness test.
   */
  it('has nothing to show for a missing or non-positive figure', () => {
    expect(displayUsd('')).toBe('')
    expect(displayUsd('nonsense')).toBe('')
    expect(displayUsd(0)).toBe('')
    expect(displayUsd(-1)).toBe('')
  })
})

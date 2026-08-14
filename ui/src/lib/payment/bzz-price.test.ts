// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'

import { usdForPlur } from '$lib/payment/bzz-price'

/** 1 BZZ in PLUR — the unit the rate is quoted per. */
const BZZ = 10n ** 16n
/** 1 xDAI in wei. */
const XDAI = 10n ** 18n

/**
 * The conversion only. How the resulting dollars are rendered belongs to
 * `displayUsd`, and is pinned in payment-rail.test.ts.
 */
describe('usdForPlur', () => {
  it('prices a whole BZZ at the quoted rate', () => {
    // 1 BZZ costs 0.5 xDAI → 1 BZZ is worth $0.50.
    expect(usdForPlur(BZZ, XDAI / 2n)).toBe('0.50')
  })

  it('scales linearly with the amount', () => {
    expect(usdForPlur(4n * BZZ, XDAI / 2n)).toBe('2.00')
  })

  /**
   * The reason the conversion cross-multiplies before dividing: a fraction of
   * a BZZ divided by the reference first would floor straight to zero.
   */
  it('keeps sub-BZZ amounts from flooring to nothing', () => {
    expect(usdForPlur(BZZ / 1000n, XDAI / 2n)).toBe('0.0005')
  })

  /**
   * Matches what was measured against the real pool on 2026-08-10: BZZ at
   * 0.0376 xDAI, a 6.6 GB drive for a year needing 187.47 BZZ.
   */
  it('reproduces a real mainnet quote', () => {
    const rate = 37_598_098_613_414_130n // 0.0375980986 xDAI per BZZ
    const total = 1_874_658_520_675_123_200n // 187.465852 BZZ, in PLUR
    expect(usdForPlur(total, rate)).toBe('7.05')
  })

  it('has nothing to price for a zero amount or a missing rate', () => {
    expect(usdForPlur(0n, XDAI)).toBe('')
    expect(usdForPlur(BZZ, 0n)).toBe('')
  })
})

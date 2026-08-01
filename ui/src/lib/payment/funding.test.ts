// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest'

import { quoteFunding } from './funding'

const XDAI = 10n ** 18n
const PLUR = 10n ** 16n

const quoteXdaiInForBzzOut = vi.fn()
vi.mock('$lib/payment/postage-onchain', () => ({
  postageChain: () =>
    Promise.resolve({
      quoteXdaiInForBzzOut: (bzz: bigint) => quoteXdaiInForBzzOut(bzz),
    }),
}))

/** Fill BZZ at a fixed rate, degrading by `impactPercent` for the real trade
 * (the reference trade always fills at the clean rate). */
function pricedAt(rateXdaiPerBzz: bigint, referenceBzz: bigint, impactPercent: bigint) {
  return (bzz: bigint) => {
    const base = (bzz * rateXdaiPerBzz) / PLUR
    return bzz === referenceBzz ? base : base + (base * impactPercent) / 100n
  }
}

describe('quoteFunding', () => {
  const REFERENCE_BZZ = 1_000_000_000_000n

  it('adds the 20% swap buffer and the gas shortfall', async () => {
    quoteXdaiInForBzzOut.mockImplementation(pricedAt(XDAI, REFERENCE_BZZ, 0n))
    const quote = await quoteFunding({ destination: '0x0', bzz: 5n * PLUR, xdai: XDAI / 100n })
    // 5 BZZ at 1 xDAI each, +20% buffer.
    expect(quote.xdaiForBzzWei).toBe(6n * XDAI)
    expect(quote.xdaiForGasWei).toBe(XDAI / 100n)
    expect(quote.xdaiWei).toBe(6n * XDAI + XDAI / 100n)
    expect(quote.bzzPlur).toBe(5n * PLUR)
  })

  it('skips the swap quote entirely for a gas-only shortfall', async () => {
    quoteXdaiInForBzzOut.mockClear()
    const quote = await quoteFunding({ destination: '0x0', bzz: 0n, xdai: XDAI / 100n })
    expect(quoteXdaiInForBzzOut).not.toHaveBeenCalled()
    expect(quote.xdaiWei).toBe(XDAI / 100n)
  })

  it('refuses a trade that would move the thin BZZ pool too far', async () => {
    quoteXdaiInForBzzOut.mockImplementation(pricedAt(XDAI, REFERENCE_BZZ, 12n))
    await expect(quoteFunding({ destination: '0x0', bzz: 1000n * PLUR, xdai: 0n })).rejects.toThrow(
      /move the BZZ price by about 12%/,
    )
  })

  it('allows impact within tolerance', async () => {
    quoteXdaiInForBzzOut.mockImplementation(pricedAt(XDAI, REFERENCE_BZZ, 3n))
    await expect(
      quoteFunding({ destination: '0x0', bzz: 10n * PLUR, xdai: 0n }),
    ).resolves.toBeDefined()
  })
})

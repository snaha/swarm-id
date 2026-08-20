// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SWAP_GAS_XDAI_WEI, quoteFunding } from './funding'

const XDAI = 10n ** 18n
const PLUR = 10n ** 16n

// Hoisted: the mock factory reads this eagerly, above the imports.
const { GAS_BUDGET } = vi.hoisted(() => ({ GAS_BUDGET: 10n ** 18n / 200n })) // 0.005 xDAI

const quoteXdaiInForBzzOut = vi.fn()
/** The owner address's xDAI, which the quote consumes before asking the rail. */
let ownerXdai = 0n
// A fixed budget: what the operation reserves for gas is the postage engine's
// business, and these tests are about what the rail is asked to deliver.
vi.mock('$lib/payment/postage-onchain', () => ({
  gasBudgetXdai: () => Promise.resolve(GAS_BUDGET),
}))
vi.mock('$lib/payment/chain', () => ({
  postageChain: () =>
    Promise.resolve({
      quoteXdaiInForBzzOut: (bzz: bigint) => quoteXdaiInForBzzOut(bzz),
      getNativeBalance: () => Promise.resolve(ownerXdai),
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

  beforeEach(() => {
    ownerXdai = 0n
  })

  it('adds the 20% swap buffer and the gas shortfall', async () => {
    quoteXdaiInForBzzOut.mockImplementation(pricedAt(XDAI, REFERENCE_BZZ, 0n))
    const quote = await quoteFunding({ destination: '0x0', bzz: 5n * PLUR, xdai: XDAI / 100n })
    // 5 BZZ at 1 xDAI each, +20% buffer.
    expect(quote.xdaiForBzzWei).toBe(6n * XDAI)
    expect(quote.xdaiForGasWei).toBe(XDAI / 100n + SWAP_GAS_XDAI_WEI)
    expect(quote.xdaiWei).toBe(6n * XDAI + XDAI / 100n + SWAP_GAS_XDAI_WEI)
    expect(quote.bzzPlur).toBe(5n * PLUR)
  })

  it('leaves the requested gas intact after the swap has paid for itself', async () => {
    // The swap runs from the owner address, before the operations the gas
    // budget covers, and pays its own gas out of the same balance. If the
    // delivery is not sized for that, the funds check re-run right after finds
    // the budget one swap short and rejects a payment that fully succeeded.
    quoteXdaiInForBzzOut.mockImplementation(pricedAt(XDAI, REFERENCE_BZZ, 0n))
    const gasShortfall = XDAI / 100n
    const quote = await quoteFunding({ destination: '0x0', bzz: 5n * PLUR, xdai: gasShortfall })
    const afterSwap = quote.xdaiWei - quote.xdaiForBzzWei - SWAP_GAS_XDAI_WEI
    expect(afterSwap).toBe(gasShortfall)
  })

  it('covers the swap even when the owner already holds the gas budget', async () => {
    // A zero gas shortfall means the owner is exactly at the budget, not above
    // it — the swap would still spend it back down.
    quoteXdaiInForBzzOut.mockImplementation(pricedAt(XDAI, REFERENCE_BZZ, 0n))
    ownerXdai = GAS_BUDGET
    const quote = await quoteFunding({ destination: '0x0', bzz: 5n * PLUR, xdai: 0n })
    expect(quote.xdaiWei - quote.xdaiForBzzWei).toBe(SWAP_GAS_XDAI_WEI)
  })

  it('spends xDAI stranded at the owner address before asking the rail', async () => {
    // What an earlier attempt delivered and never swapped is the user's money,
    // sitting exactly where the swap spends from. Quoting the full amount again
    // charges them twice for the same BZZ.
    quoteXdaiInForBzzOut.mockImplementation(pricedAt(XDAI, REFERENCE_BZZ, 0n))
    const stranded = 2n * XDAI
    ownerXdai = GAS_BUDGET + stranded
    const quote = await quoteFunding({ destination: '0x0', bzz: 5n * PLUR, xdai: 0n })
    // 6 xDAI of swap input + the swap's gas, less the 2 already there.
    expect(quote.xdaiWei).toBe(6n * XDAI + SWAP_GAS_XDAI_WEI - stranded)
    // The swap still spends the full input — the surplus is part of it.
    expect(quote.xdaiForBzzWei).toBe(6n * XDAI)
  })

  it('asks for nothing when the stranded xDAI already covers the operation', async () => {
    // The payment screens must not open to collect zero: the caller swaps what
    // is already there and carries on.
    quoteXdaiInForBzzOut.mockImplementation(pricedAt(XDAI, REFERENCE_BZZ, 0n))
    ownerXdai = GAS_BUDGET + 10n * XDAI
    const quote = await quoteFunding({ destination: '0x0', bzz: 5n * PLUR, xdai: 0n })
    expect(quote.xdaiWei).toBe(0n)
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

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SWAP_GAS_XDAI_WEI, priceImpactRefusal, quoteFunding, settleWith } from './funding'

const XDAI = 10n ** 18n
const PLUR = 10n ** 16n

// Hoisted: the mock factory reads this eagerly, above the imports.
const { GAS_BUDGET } = vi.hoisted(() => ({ GAS_BUDGET: 10n ** 18n / 200n })) // 0.005 xDAI

const quoteXdaiInForBzzOut = vi.fn()
/** The owner address's xDAI, which the quote consumes before asking the rail. */
let ownerXdai = 0n
vi.mock('$lib/payment/postage-onchain', () => ({
  GAS_BUDGET_XDAI_WEI: GAS_BUDGET,
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
  /** Must track `IMPACT_REFERENCE_BZZ_PLUR` — the stub prices this size at par. */
  const REFERENCE_BZZ = 10_000_000_000_000_000n

  beforeEach(() => {
    ownerXdai = 0n
  })

  it('adds the 20% swap buffer and the gas shortfall', async () => {
    quoteXdaiInForBzzOut.mockImplementation(pricedAt(XDAI, REFERENCE_BZZ, 0n))
    const quote = await quoteFunding({ destination: '0x0', bzz: 5n * PLUR, xdai: XDAI / 100n })
    // 5 BZZ at 1 xDAI each, +20% buffer.
    expect(quote.xdaiForBzzWei).toBe(6n * XDAI)
    // An empty owner address is the whole budget short, plus the swap's own gas.
    expect(quote.xdaiForGasWei).toBe(GAS_BUDGET + SWAP_GAS_XDAI_WEI)
    expect(quote.xdaiWei).toBe(6n * XDAI + GAS_BUDGET + SWAP_GAS_XDAI_WEI)
    expect(quote.bzzPlur).toBe(5n * PLUR)
  })

  it('leaves the operating budget intact after the swap has paid for itself', async () => {
    // The swap runs from the owner address, before the operations the gas
    // budget covers, and pays its own gas out of the same balance. If the
    // delivery is not sized for that, the funds check re-run right after finds
    // the budget one swap short and rejects a payment that fully succeeded.
    quoteXdaiInForBzzOut.mockImplementation(pricedAt(XDAI, REFERENCE_BZZ, 0n))
    const quote = await quoteFunding({ destination: '0x0', bzz: 5n * PLUR, xdai: 0n })
    const afterSwap = quote.xdaiWei - quote.xdaiForBzzWei - SWAP_GAS_XDAI_WEI
    expect(afterSwap).toBe(GAS_BUDGET)
  })

  it('does not charge again for a gas leg that already landed', async () => {
    // The need is captured once, before the first payment screen opens, and
    // every re-price after a failed attempt reuses it. Sizing the gas from that
    // stale figure collected the gas leg a second time while the first one sat
    // at the owner address — where the same read is meanwhile crediting it as
    // surplus.
    quoteXdaiInForBzzOut.mockImplementation(pricedAt(XDAI, REFERENCE_BZZ, 0n))
    const stale = { destination: '0x0', bzz: 5n * PLUR, xdai: GAS_BUDGET }
    ownerXdai = GAS_BUDGET + SWAP_GAS_XDAI_WEI
    const quote = await quoteFunding(stale)
    // The budget is covered, so only the swap's own gas is still owed — and the
    // xDAI above the budget already covers that, leaving just the swap input.
    expect(quote.xdaiForGasWei).toBe(SWAP_GAS_XDAI_WEI)
    expect(quote.xdaiWei).toBe(6n * XDAI)
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
    // The gas budget, less nothing: the swap's own gas is not owed when no swap
    // runs, and the owner address holds nothing.
    expect(quote.xdaiWei).toBe(GAS_BUDGET)
  })

  /**
   * Impact is measured and carried, never thrown. Refusing here would refuse
   * the payment, and one of the four ways to pay — BZZ — runs no swap at all,
   * so the user who could most easily afford a large resize was the one the
   * throw stopped. `priceImpactRefusal` is where the judgement lands, once the
   * token is known.
   */
  it('reports how far the trade would move the pool', async () => {
    quoteXdaiInForBzzOut.mockImplementation(pricedAt(XDAI, REFERENCE_BZZ, 12n))
    const quote = await quoteFunding({ destination: '0x0', bzz: 1000n * PLUR, xdai: 0n })
    expect(quote.priceImpactPercent).toBe(12n)
    expect(quote.xdaiWei).toBeGreaterThan(0n)
  })

  it('reports impact within tolerance too', async () => {
    quoteXdaiInForBzzOut.mockImplementation(pricedAt(XDAI, REFERENCE_BZZ, 3n))
    const quote = await quoteFunding({ destination: '0x0', bzz: 10n * PLUR, xdai: 0n })
    expect(quote.priceImpactPercent).toBe(3n)
  })

  it('measures no impact where no swap is priced', async () => {
    const quote = await quoteFunding({ destination: '0x0', bzz: 0n, xdai: XDAI / 100n })
    expect(quote.priceImpactPercent).toBe(0n)
  })
})

describe('priceImpactRefusal', () => {
  it('refuses a trade that would move the thin BZZ pool too far', () => {
    expect(priceImpactRefusal(12n)).toMatch(/move the BZZ price by about 12%/)
  })

  it('points at the one asset that touches no pool', () => {
    expect(priceImpactRefusal(12n)).toMatch(/pay in BZZ/)
  })

  it('allows impact within tolerance', () => {
    expect(priceImpactRefusal(5n)).toBeUndefined()
    expect(priceImpactRefusal(0n)).toBeUndefined()
  })
})

/**
 * Which figure the swap ends up spending. The rail is authoritative for a token
 * leg and NOT for the native one, and getting that backwards spends the wrong
 * amount at the far end of a payment that already succeeded.
 */
describe('settleWith', () => {
  const quote = {
    xdaiWei: 4n * XDAI,
    xdaiForBzzWei: 6n * XDAI,
    xdaiForGasWei: SWAP_GAS_XDAI_WEI,
    bzzPlur: 5n * PLUR,
    priceImpactPercent: 0n,
    paidWith: 'xdai',
    paidAmount: 6n * XDAI,
  } as const

  it('swaps the whole input for an xDAI payment, surplus included', () => {
    // The rail carried 4 xDAI because 2 were already stranded at the owner
    // address — but the swap spends all 6, and settling from the delivery
    // would leave the stranded pair unswapped and the operation short.
    const settled = settleWith(quote, { input: 'xdai', amount: 4n * XDAI - SWAP_GAS_XDAI_WEI })
    expect(settled.paidWith).toBe('xdai')
    expect(settled.paidAmount).toBe(6n * XDAI)
  })

  it('swaps exactly what the rail says it sent for a token payment', () => {
    const settled = settleWith(quote, { input: 'usdc', amount: 9_030_000n })
    expect(settled.paidWith).toBe('usdc')
    expect(settled.paidAmount).toBe(9_030_000n)
  })

  it('carries the Gnosis-side figures through untouched', () => {
    const settled = settleWith(quote, { input: 'bzz', amount: 5n * PLUR })
    expect(settled.xdaiForBzzWei).toBe(quote.xdaiForBzzWei)
    expect(settled.bzzPlur).toBe(quote.bzzPlur)
  })
})

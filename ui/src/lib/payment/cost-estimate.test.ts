// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The form's figure and the pay screen's are the same money one step apart. A
 * form that priced the swap near spot while the screen collected the swap
 * buffer would read as a price that moved on the way in.
 */
import { formatUnits } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { displayUsd } from '$lib/payment/payment-rail'

import { estimatedUsd } from './cost-estimate.svelte'
import { quoteFunding } from './funding'

const XDAI = 10n ** 18n
const PLUR = 10n ** 16n

// Hoisted: the mock factory reads this eagerly, above the imports.
const { GAS_BUDGET } = vi.hoisted(() => ({ GAS_BUDGET: 10n ** 18n / 200n })) // 0.005 xDAI

/** 1 xDAI per BZZ, the same pool answering both sides of the comparison. */
const quoteXdaiInForBzzOut = (bzz: bigint) => Promise.resolve((bzz * XDAI) / PLUR)

vi.mock('$lib/payment/postage-onchain', () => ({
  GAS_BUDGET_XDAI_WEI: GAS_BUDGET,
}))
vi.mock('$lib/payment/chain', () => ({
  postageChain: () =>
    Promise.resolve({
      quoteXdaiInForBzzOut,
      // An empty owner address: nothing stranded to credit either figure with.
      getNativeBalance: () => Promise.resolve(0n),
    }),
}))

/** The rate the estimate converts with: xDAI for one BZZ, near spot. */
const RATE = XDAI

describe('estimatedUsd', () => {
  const cost = { depth: 20, amountPerChunk: PLUR }
  const totalPlur = cost.amountPerChunk << BigInt(cost.depth)

  it('prices a batch at the figure the pay screen will collect for it', async () => {
    const quote = await quoteFunding({ destination: '0x0', bzz: totalPlur, xdai: 0n })
    // Gas aside — it depends on a live balance read the form does not make —
    // the two are the same swap, quoted through the same pool with the same
    // headroom on top.
    expect(estimatedUsd(cost, RATE)).toBe(displayUsd(formatUnits(quote.xdaiForBzzWei, 18)))
  })

  it('says nothing when the pool could not be priced', () => {
    // The caller falls back to the BZZ figure, which needs no pool at all.
    expect(estimatedUsd(cost, undefined)).toBe('')
  })

  it('has nothing to price for an empty batch', () => {
    expect(estimatedUsd({ depth: 20, amountPerChunk: 0n }, RATE)).toBe('')
  })
})

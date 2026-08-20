// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id'
import { describe, expect, it } from 'vitest'

import {
  extendedStamp,
  parseBlockNumber,
  resizePlan,
  stampAmountForSeconds,
  stampTtlSeconds,
  ttlSecondsFor,
} from './purchase'

const DAY = 24 * 60 * 60

function makeStamp(overrides: Partial<PostageStamp> = {}): PostageStamp {
  return {
    batchID: new BatchId('a'.repeat(64)),
    name: 'Drive 1',
    signerKey: new PrivateKey('b'.repeat(64)),
    depth: 20,
    amount: 1000n,
    bucketDepth: 16,
    blockNumber: 1,
    immutableFlag: false,
    utilization: 0.5,
    usable: true,
    exists: true,
    batchTTL: 100 * DAY,
    createdAt: 0,
    ...overrides,
  }
}

describe('parseBlockNumber', () => {
  it('parses hex and decimal forms', () => {
    expect(parseBlockNumber('0x2a')).toBe(42)
    expect(parseBlockNumber('42')).toBe(42)
  })

  it('falls back to 0 for garbage and non-integer input', () => {
    expect(parseBlockNumber('nope')).toBe(0)
    expect(parseBlockNumber('42.5')).toBe(0)
  })
})

describe('extendedStamp', () => {
  it('adds funds and lifespan on top of the current remaining TTL', () => {
    const update = extendedStamp(makeStamp({ amount: 1000n }), 30 * DAY, 300n, 100 * DAY)
    expect(update.amount).toBe(1300n)
    expect(update.batchTTL).toBe(130 * DAY)
  })

  it('treats an unknown TTL as zero', () => {
    const update = extendedStamp(makeStamp(), 10 * DAY, 0n, undefined)
    expect(update.batchTTL).toBe(10 * DAY)
  })

  it('clamps an already-expired TTL to zero instead of eating the extension', () => {
    const update = extendedStamp(makeStamp(), 10 * DAY, 0n, -3 * DAY)
    expect(update.batchTTL).toBe(10 * DAY)
  })
})

describe('resizePlan', () => {
  // A price of 1 PLUR/chunk/block makes TTLs read as blocks × 5s directly.
  const PRICE = 1n
  const BLOCKS_PER_DAY = (24n * 60n * 60n) / 5n
  // Live remaining balance worth 100 days at PRICE; well above the floor.
  const REMAINING = 100n * BLOCKS_PER_DAY
  // Contract floor ≈ 1 day of storage.
  const MINIMUM = 1n * BLOCKS_PER_DAY

  it('keep-lifespan tops up remaining × (2^Δ − 1) BEFORE the increase', () => {
    const plan = resizePlan(20, 22, true, REMAINING, MINIMUM, PRICE)
    expect(plan.topUpAmount).toBe(REMAINING * 3n) // 2^2 − 1
    expect(plan.clampedToFloor).toBe(false)
    // Final state: new depth, lifespan back to the current 100 days.
    expect(plan.afterDilute.depth).toBe(22)
    expect(plan.afterDilute.amount).toBe(REMAINING)
    expect(plan.afterDilute.batchTTL).toBe(100 * DAY)
  })

  it('keep-lifespan total cost matches the old dilute-first model', () => {
    // Old model: (amount − amount/2^Δ) per chunk at the NEW depth.
    // New model: amount × (2^Δ − 1) per chunk at the OLD depth. Same total.
    const oldTotal = (REMAINING - REMAINING / 4n) << 22n
    const newTotal = resizePlan(20, 22, true, REMAINING, MINIMUM, PRICE).topUpAmount << 20n
    expect(newTotal).toBe(oldTotal)
  })

  it('without keep-lifespan the balance and lifespan divide by 2^Δ', () => {
    const plan = resizePlan(20, 22, false, REMAINING, MINIMUM, PRICE)
    expect(plan.topUpAmount).toBe(0n)
    expect(plan.clampedToFloor).toBe(false)
    expect(plan.afterDilute.amount).toBe(REMAINING / 4n)
    expect(plan.afterDilute.batchTTL).toBe(25 * DAY)
  })

  it('raises the top-up to the contract floor when the projection misses it', () => {
    // 2 days remaining, ÷4 would leave half a day — under the ~1-day minimum.
    const low = 2n * BLOCKS_PER_DAY
    const plan = resizePlan(20, 22, false, low, MINIMUM, PRICE)
    expect(plan.clampedToFloor).toBe(true)
    // Top-up raises the pre-dilution balance to exactly minimum × 2^Δ.
    expect(low + plan.topUpAmount).toBe(MINIMUM * 4n)
    expect(plan.afterDilute.amount).toBe(MINIMUM)
  })

  it('clamps keep-lifespan too when even that misses the floor', () => {
    // Remaining under the minimum itself: keeping lifespan is not enough.
    const tiny = MINIMUM / 2n
    const plan = resizePlan(20, 21, true, tiny, MINIMUM, PRICE)
    expect(plan.clampedToFloor).toBe(true)
    expect(tiny + plan.topUpAmount).toBe(MINIMUM * 2n)
  })

  it('reports unknown TTLs on a zero price instead of guessing', () => {
    const plan = resizePlan(20, 21, true, REMAINING, MINIMUM, 0n)
    expect(plan.afterDilute.batchTTL).toBeUndefined()
  })
})

describe('ttlSecondsFor', () => {
  it('converts a per-chunk balance to funded seconds', () => {
    expect(ttlSecondsFor(17_280n * 24_000n, 24_000n)).toBe(DAY)
  })

  it('is 0 when drained and undefined when unpriceable', () => {
    expect(ttlSecondsFor(0n, 24_000n)).toBe(0)
    expect(ttlSecondsFor(1000n, 0n)).toBeUndefined()
  })
})

describe('stampAmountForSeconds / stampTtlSeconds', () => {
  const BLOCKS_PER_DAY = (24n * 60n * 60n) / 5n // Gnosis 5s block time
  const PRICE = 24_000n

  it('funds whole days, rounding a fractional day up (24h floor)', () => {
    expect(stampAmountForSeconds(PRICE, DAY)).toBe(PRICE * BLOCKS_PER_DAY)
    expect(stampAmountForSeconds(PRICE, DAY + 1)).toBe(PRICE * BLOCKS_PER_DAY * 2n)
    expect(stampAmountForSeconds(PRICE, 1)).toBe(PRICE * BLOCKS_PER_DAY)
  })

  it('inverts stampAmountForSeconds back to whole days', () => {
    const amount = stampAmountForSeconds(PRICE, 30 * DAY)
    expect(stampTtlSeconds(amount, PRICE)).toBe(30 * DAY)
  })

  it('returns undefined for unpriceable inputs', () => {
    expect(stampTtlSeconds(0n, PRICE)).toBeUndefined()
    expect(stampTtlSeconds(1000n, 0n)).toBeUndefined()
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id'
import { describe, expect, it } from 'vitest'

import {
  dilutedStamp,
  extendedStamp,
  parseBlockNumber,
  stampAmountForSeconds,
  stampTtlSeconds,
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

describe('dilutedStamp', () => {
  it('halves balance and lifespan per depth step when not preserving lifespan', () => {
    const { afterDilute, topUpAmount, afterTopUp } = dilutedStamp(
      makeStamp({ depth: 20, amount: 1000n }),
      22,
      false,
      100 * DAY,
    )
    expect(afterDilute.depth).toBe(22)
    expect(afterDilute.amount).toBe(250n) // 1000 / 2^2
    expect(afterDilute.batchTTL).toBe(25 * DAY) // 100d / 4
    expect(topUpAmount).toBe(0n)
    expect(afterTopUp).toEqual(afterDilute) // no top-up → nothing more changes
  })

  it('preserves balance and lifespan via a compensating top-up', () => {
    const { afterDilute, topUpAmount, afterTopUp } = dilutedStamp(
      makeStamp({ depth: 20, amount: 1000n }),
      21,
      true,
      100 * DAY,
    )
    // The dilute alone halves the balance and lifespan…
    expect(afterDilute.amount).toBe(500n)
    expect(afterDilute.batchTTL).toBe(50 * DAY)
    // …and the compensating top-up restores both.
    expect(topUpAmount).toBe(500n) // 1000 - 1000/2
    expect(afterTopUp.depth).toBe(21)
    expect(afterTopUp.amount).toBe(1000n)
    expect(afterTopUp.batchTTL).toBe(100 * DAY)
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

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id'
import { describe, expect, it } from 'vitest'

import { dilutedStamp, extendedStamp, parseBlockNumber } from './purchase'

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

  it('falls back to 0 for garbage', () => {
    expect(parseBlockNumber('nope')).toBe(0)
  })
})

describe('extendedStamp', () => {
  it('adds funds and lifespan', () => {
    const update = extendedStamp(makeStamp({ amount: 1000n, batchTTL: 100 * DAY }), 30 * DAY, 300n)
    expect(update.amount).toBe(1300n)
    expect(update.batchTTL).toBe(130 * DAY)
  })

  it('treats an unknown TTL as zero', () => {
    const update = extendedStamp(makeStamp({ batchTTL: undefined }), 10 * DAY, 0n)
    expect(update.batchTTL).toBe(10 * DAY)
  })
})

describe('dilutedStamp', () => {
  it('halves balance and lifespan per depth step when not preserving lifespan', () => {
    const { update, topUpAmount } = dilutedStamp(
      makeStamp({ depth: 20, amount: 1000n, batchTTL: 100 * DAY }),
      22,
      false,
    )
    expect(update.depth).toBe(22)
    expect(update.amount).toBe(250n) // 1000 / 2^2
    expect(update.batchTTL).toBe(25 * DAY) // 100d / 4
    expect(topUpAmount).toBe(0n)
  })

  it('preserves balance and lifespan via a compensating top-up', () => {
    const { update, topUpAmount } = dilutedStamp(
      makeStamp({ depth: 20, amount: 1000n, batchTTL: 100 * DAY }),
      21,
      true,
    )
    expect(update.depth).toBe(21)
    expect(update.amount).toBe(1000n)
    expect(update.batchTTL).toBeUndefined() // lifespan preserved → not patched
    expect(topUpAmount).toBe(500n) // 1000 - 1000/2
  })
})

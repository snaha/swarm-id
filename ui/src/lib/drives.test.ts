// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id'
import { describe, expect, it } from 'vitest'

import { describeDrive, formatBytes, formatRemaining, remainingLifespanSeconds } from './drives'

const DAY = 24 * 60 * 60

function makeDrive(overrides: Partial<PostageStamp> = {}): PostageStamp {
  return {
    batchID: new BatchId('a'.repeat(64)),
    signerKey: new PrivateKey('b'.repeat(64)),
    depth: 24,
    amount: 100000000n,
    bucketDepth: 16,
    blockNumber: 1,
    immutableFlag: false,
    utilization: 0.25,
    usable: true,
    exists: true,
    batchTTL: 90 * DAY,
    createdAt: Date.UTC(2026, 8, 21), // 2026-09-21 (month is 0-based)
    ...overrides,
  }
}

describe('formatBytes', () => {
  it('formats whole binary units without decimals', () => {
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB')
    expect(formatBytes(64 * 1024 * 1024 * 1024)).toBe('64 GB')
  })

  it('keeps one decimal for small fractional values', () => {
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
  })

  it('handles zero and non-finite input', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

describe('formatRemaining', () => {
  it('renders years, months, days and hours', () => {
    expect(formatRemaining(400 * DAY)).toBe('1 year left')
    expect(formatRemaining(90 * DAY)).toBe('3 months left')
    expect(formatRemaining(5 * DAY)).toBe('5 days left')
    expect(formatRemaining(2 * 60 * 60)).toBe('2 hours left')
  })

  it('singularises a single unit', () => {
    expect(formatRemaining(1 * DAY)).toBe('1 day left')
  })

  it('returns empty string for non-positive input', () => {
    expect(formatRemaining(0)).toBe('')
    expect(formatRemaining(-10)).toBe('')
  })
})

describe('remainingLifespanSeconds', () => {
  const measuredAt = Date.UTC(2026, 0, 1)

  it('ages the stored snapshot by the time elapsed since it was measured', () => {
    const drive = makeDrive({ batchTTL: 90 * DAY, createdAt: measuredAt })
    expect(remainingLifespanSeconds(drive, measuredAt)).toBe(90 * DAY)
    expect(remainingLifespanSeconds(drive, measuredAt + 30 * DAY * 1000)).toBe(60 * DAY)
    expect(remainingLifespanSeconds(drive, measuredAt + 91 * DAY * 1000)).toBe(-1 * DAY)
  })

  it('prefers updatedAt (a node edit re-measures the TTL) over createdAt', () => {
    const drive = makeDrive({
      batchTTL: 90 * DAY,
      createdAt: measuredAt,
      updatedAt: measuredAt + 30 * DAY * 1000,
    })
    expect(remainingLifespanSeconds(drive, measuredAt + 30 * DAY * 1000)).toBe(90 * DAY)
  })

  it('passes an unknown TTL through', () => {
    expect(remainingLifespanSeconds(makeDrive({ batchTTL: undefined }))).toBeUndefined()
  })
})

describe('describeDrive', () => {
  // The drive's TTL snapshot was measured at createdAt (2026-09-21); render at
  // the same instant so the un-aged values are exercised first.
  const measuredAt = Date.UTC(2026, 8, 21)

  it('describes an active drive', () => {
    const display = describeDrive(makeDrive({ batchTTL: 90 * DAY }), measuredAt)
    expect(display.status).toBe('active')
    expect(display.timeLeftLabel).toBe('3 months left')
    expect(display.expiryDate).toBe('2026-12-20')
    expect(display.usedPercent).toBe(25)
    expect(display.storageFull).toBe(false)
    expect(display.purchasedOn).toBe('2026-09-21')
  })

  it('ages the countdown as time passes without any node refresh', () => {
    const drive = makeDrive({ batchTTL: 90 * DAY })
    const later = describeDrive(drive, measuredAt + 89 * DAY * 1000)
    expect(later.status).toBe('expires-soon')
    expect(later.timeLeftLabel).toBe('1 day left')
    // The expiry date stays anchored instead of sliding forward every render.
    expect(later.expiryDate).toBe('2026-12-20')
    expect(describeDrive(drive, measuredAt + 91 * DAY * 1000).status).toBe('expired')
  })

  it('flags drives close to expiry', () => {
    const display = describeDrive(makeDrive({ batchTTL: 6 * DAY }), measuredAt)
    expect(display.status).toBe('expires-soon')
    expect(display.timeLeftLabel).not.toBe('')
  })

  it('flags expired drives and hides the lifespan', () => {
    const display = describeDrive(makeDrive({ batchTTL: 0 }), measuredAt)
    expect(display.status).toBe('expired')
    expect(display.timeLeftLabel).toBe('')
    expect(display.expiryDate).toBeUndefined()
  })

  it('flags a full drive', () => {
    expect(describeDrive(makeDrive({ utilization: 1 }), measuredAt).storageFull).toBe(true)
  })

  it('clamps utilization to the 0–100 range', () => {
    expect(describeDrive(makeDrive({ utilization: 1.2 }), measuredAt).usedPercent).toBe(100)
    expect(describeDrive(makeDrive({ utilization: -0.1 }), measuredAt).usedPercent).toBe(0)
  })

  it('reserves 100% for an actually-full drive', () => {
    const almostFull = describeDrive(makeDrive({ utilization: 0.996 }), measuredAt)
    expect(almostFull.usedPercent).toBe(99)
    expect(almostFull.storageFull).toBe(false)
    const full = describeDrive(makeDrive({ utilization: 1 }), measuredAt)
    expect(full.usedPercent).toBe(100)
    expect(full.storageFull).toBe(true)
  })

  it('names drives, falling back to a stable batch-ID-derived label', () => {
    expect(describeDrive(makeDrive({ name: 'Photos' }), measuredAt).name).toBe('Photos')
    expect(describeDrive(makeDrive({ name: undefined }), measuredAt).name).toBe('Drive aaaa')
    expect(describeDrive(makeDrive({ name: '   ' }), measuredAt).name).toBe('Drive aaaa')
    const other = makeDrive({ name: undefined, batchID: new BatchId('7cf2'.padEnd(64, '0')) })
    expect(describeDrive(other, measuredAt).name).toBe('Drive 7cf2')
  })

  it('treats unknown TTL as active with no lifespan labels', () => {
    const display = describeDrive(makeDrive({ batchTTL: undefined }), measuredAt)
    expect(display.status).toBe('active')
    expect(display.timeLeftLabel).toBe('')
    expect(display.expiryDate).toBeUndefined()
  })
})

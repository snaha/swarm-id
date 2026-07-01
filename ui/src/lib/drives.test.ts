// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id'
import { describe, expect, it } from 'vitest'

import {
  EXPIRES_SOON_THRESHOLD_SECONDS,
  describeDrive,
  driveDisplayName,
  driveUsedPercent,
  formatBytes,
  formatRemaining,
} from './drives'

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

describe('driveUsedPercent', () => {
  it('rounds the 0–1 fraction to a clamped percentage', () => {
    expect(driveUsedPercent(makeDrive({ utilization: 0.25 }))).toBe(25)
    expect(driveUsedPercent(makeDrive({ utilization: 1.2 }))).toBe(100)
    expect(driveUsedPercent(makeDrive({ utilization: -0.1 }))).toBe(0)
  })
})

describe('driveDisplayName', () => {
  it('uses the name when present', () => {
    expect(driveDisplayName(makeDrive({ name: 'Photos' }), 3)).toBe('Photos')
  })

  it('falls back to a positional label', () => {
    expect(driveDisplayName(makeDrive({ name: undefined }), 0)).toBe('Drive 1')
    expect(driveDisplayName(makeDrive({ name: '   ' }), 2)).toBe('Drive 3')
  })
})

describe('describeDrive', () => {
  const now = Date.UTC(2026, 5, 24) // 2026-06-24

  it('describes an active drive', () => {
    const display = describeDrive(makeDrive({ batchTTL: 90 * DAY }), 0, now)
    expect(display.status).toBe('active')
    expect(display.timeLeftLabel).toBe('3 months left')
    expect(display.expiryDate).toBe('2026-09-22')
    expect(display.usedPercent).toBe(25)
    expect(display.storageFull).toBe(false)
    expect(display.purchasedOn).toBe('2026-09-21')
  })

  it('flags drives close to expiry', () => {
    const display = describeDrive(
      makeDrive({ batchTTL: EXPIRES_SOON_THRESHOLD_SECONDS - DAY }),
      0,
      now,
    )
    expect(display.status).toBe('expires-soon')
    expect(display.timeLeftLabel).not.toBe('')
  })

  it('flags expired drives and hides the lifespan', () => {
    const display = describeDrive(makeDrive({ batchTTL: 0 }), 0, now)
    expect(display.status).toBe('expired')
    expect(display.timeLeftLabel).toBe('')
    expect(display.expiryDate).toBeUndefined()
  })

  it('flags a full drive', () => {
    expect(describeDrive(makeDrive({ utilization: 1 }), 0, now).storageFull).toBe(true)
  })

  it('treats unknown TTL as active with no lifespan labels', () => {
    const display = describeDrive(makeDrive({ batchTTL: undefined }), 0, now)
    expect(display.status).toBe('active')
    expect(display.timeLeftLabel).toBe('')
    expect(display.expiryDate).toBeUndefined()
  })
})

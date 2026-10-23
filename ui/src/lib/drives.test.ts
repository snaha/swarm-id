// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey, RedundancyLevel, Utils } from '@ethersphere/bee-js'
import { MIN_USABLE_BATCH_DEPTH, type PostageStamp } from '@snaha/swarm-id/internal'
import { describe, expect, it } from 'vitest'

import {
  DRIVE_SIZE_BREAKPOINTS,
  accountDriveAttention,
  appsUsingDrive,
  attentionKey,
  describeDrive,
  driveAttentionDescription,
  driveAttentionLabel,
  driveEffectiveBytes,
  driveNeedsAttention,
  drivesNeedingAttention,
  expiredDriveAlerts,
  formatBytes,
  formatRemaining,
  remainingLifespanSeconds,
  soonestDriveExpiry,
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

  it('marks only a live drive modifiable', () => {
    expect(describeDrive(makeDrive({ batchTTL: 90 * DAY }), measuredAt).modifiable).toBe(true)
    expect(describeDrive(makeDrive({ batchTTL: 6 * DAY }), measuredAt).modifiable).toBe(true)
    // Unknown TTL is treated as active: don't hide the actions on a stamp
    // stored before the source recorded a TTL.
    expect(describeDrive(makeDrive({ batchTTL: undefined }), measuredAt).modifiable).toBe(true)
    expect(describeDrive(makeDrive({ batchTTL: 0 }), measuredAt).modifiable).toBe(false)
    expect(describeDrive(makeDrive({ batchTTL: -DAY }), measuredAt).modifiable).toBe(false)
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

describe('drivesNeedingAttention', () => {
  const measuredAt = Date.UTC(2026, 8, 21)

  it('counts expiring and full drives, not expired or healthy ones', () => {
    const account = {
      stamps: [
        makeDrive({ batchTTL: 90 * DAY }), // healthy
        makeDrive({ batchTTL: 6 * DAY }), // expires soon
        makeDrive({ utilization: 1 }), // storage full
        makeDrive({ batchTTL: 0 }), // expired — gone, not actionable
        makeDrive({ batchTTL: 0, utilization: 1 }), // expired AND full — still gone
      ],
    }
    expect(drivesNeedingAttention(account, measuredAt)).toBe(2)
  })

  it('is zero for an account without drives (e.g. signed out)', () => {
    expect(drivesNeedingAttention({ stamps: [] }, measuredAt)).toBe(0)
  })

  it('flags a drive that is both expiring and full once', () => {
    expect(driveNeedsAttention(makeDrive({ batchTTL: 6 * DAY, utilization: 1 }), measuredAt)).toBe(
      true,
    )
  })
})

describe('expiredDriveAlerts', () => {
  const measuredAt = Date.UTC(2026, 8, 21)
  const hex = (char: string) => char.repeat(64)
  const live = makeDrive({ batchID: new BatchId(hex('1')), name: 'Live' })
  const expired = makeDrive({ batchID: new BatchId(hex('2')), name: 'Drive 5', batchTTL: 0 })
  const expiredDefault = makeDrive({ batchID: new BatchId(hex('3')), batchTTL: 0 })

  it('alerts each expired drive, the default first and in its own words', () => {
    const account = {
      stamps: [live, expired, expiredDefault],
      defaultPostageStampBatchID: expiredDefault.batchID,
    }
    expect(expiredDriveAlerts(account, new Set(), measuredAt)).toEqual([
      {
        batchHex: hex('3'),
        message:
          'Your default drive has expired. Account data may have been lost and your account is no longer synced across devices.',
      },
      {
        batchHex: hex('2'),
        message:
          'Drive 5 has expired. Data from associated apps may have been lost and some apps may not work properly.',
      },
    ])
  })

  it('leaves out a dismissed drive', () => {
    const account = { stamps: [expired, expiredDefault] }
    const alerts = expiredDriveAlerts(account, new Set([hex('2')]), measuredAt)
    expect(alerts.map((alert) => alert.batchHex)).toEqual([hex('3')])
  })

  it('is empty without an expired drive', () => {
    expect(expiredDriveAlerts({ stamps: [live] }, new Set(), measuredAt)).toEqual([])
  })
})

describe('attentionKey', () => {
  const measuredAt = Date.UTC(2026, 8, 21)
  const expiring = (char: string, amount = 100000000n) =>
    makeDrive({ batchID: new BatchId(char.repeat(64)), batchTTL: 6 * DAY, amount })

  it('changes when a different drive needs attention, at the same count', () => {
    expect(attentionKey({ stamps: [expiring('1')] }, measuredAt)).not.toBe(
      attentionKey({ stamps: [expiring('2')] }, measuredAt),
    )
  })

  it('changes when the same drive was extended', () => {
    expect(attentionKey({ stamps: [expiring('1')] }, measuredAt)).not.toBe(
      attentionKey({ stamps: [expiring('1', 200000000n)] }, measuredAt),
    )
  })

  it('holds while the same drives need attention, in any order', () => {
    const live = makeDrive({ batchID: new BatchId('3'.repeat(64)) })
    expect(attentionKey({ stamps: [expiring('1'), live, expiring('2')] }, measuredAt)).toBe(
      attentionKey({ stamps: [expiring('2'), expiring('1')] }, measuredAt),
    )
  })
})

describe('soonestDriveExpiry / accountDriveAttention', () => {
  const measuredAt = Date.UTC(2026, 8, 21)
  const DAY_MS = DAY * 1000

  it('picks the soonest expiry, skipping unknown TTLs', () => {
    const stamps = [
      makeDrive({ batchTTL: 90 * DAY }),
      makeDrive({ batchTTL: 10 * DAY }), // soonest
      makeDrive({ batchTTL: undefined }), // unknown — skipped
    ]
    expect(soonestDriveExpiry(stamps, measuredAt)).toBe(measuredAt + 10 * DAY_MS)
  })

  it('keeps an expired drive, as a past expiry, so a sign-out remembers it', () => {
    const stamps = [makeDrive({ batchTTL: 10 * DAY }), makeDrive({ batchTTL: 0 })]
    expect(soonestDriveExpiry(stamps, measuredAt)).toBeLessThanOrEqual(measuredAt)
  })

  it('is undefined without any qualifying drive', () => {
    expect(soonestDriveExpiry([], measuredAt)).toBeUndefined()
    expect(soonestDriveExpiry([makeDrive({ batchTTL: undefined })], measuredAt)).toBeUndefined()
  })

  it('is undefined for an account whose drives are fine', () => {
    const account = { stamps: [makeDrive()], isSignedOut: false }
    expect(accountDriveAttention(account, measuredAt)).toBeUndefined()
    expect(accountDriveAttention({ stamps: [], isSignedOut: true }, measuredAt)).toBeUndefined()
  })

  it('reads a signed-out captured flag with no near expiry as a full drive', () => {
    const account = { stamps: [], isSignedOut: true, storageWarning: true }
    expect(accountDriveAttention(account, measuredAt)).toEqual({ reason: 'full' })
  })

  it('develops the signed-out warning as the stored expiry approaches', () => {
    const expiry = measuredAt + 30 * DAY_MS
    const account = { stamps: [], isSignedOut: true, soonestDriveExpiry: expiry }
    expect(accountDriveAttention(account, measuredAt)).toBeUndefined()
    // Hedged: a sign-out estimate, which another device may have moved since.
    expect(accountDriveAttention(account, expiry - 6 * DAY_MS)).toEqual({
      reason: 'may-expire',
      expiry,
    })
  })

  it('turns the signed-out warning to expired once the captured expiry is past', () => {
    const expiry = measuredAt + 30 * DAY_MS
    const account = { stamps: [], isSignedOut: true, soonestDriveExpiry: expiry }
    expect(accountDriveAttention(account, expiry + DAY_MS)).toEqual({
      reason: 'may-have-expired',
      expiry,
    })
    // Expired outranks a captured full flag.
    expect(accountDriveAttention({ ...account, storageWarning: true }, expiry + DAY_MS)).toEqual({
      reason: 'may-have-expired',
      expiry,
    })
  })

  it('uses the live drive state for signed-in accounts', () => {
    const account = { stamps: [makeDrive({ utilization: 1 })], isSignedOut: false }
    expect(accountDriveAttention(account, measuredAt)).toEqual({ reason: 'full' })
  })

  it('reports an expired drive first, over an expiring or full one', () => {
    const account = {
      stamps: [
        makeDrive({ utilization: 1 }),
        makeDrive({ batchTTL: 3 * DAY }),
        makeDrive({ batchTTL: 0 }),
      ],
      isSignedOut: false,
    }
    expect(accountDriveAttention(account, measuredAt)).toEqual({ reason: 'expired' })
  })

  it('reports the soonest EXPIRING drive, not a full one that outlives it', () => {
    const account = {
      stamps: [
        makeDrive({ utilization: 1 }), // full, but 90 days of life left
        makeDrive({ batchTTL: 6 * DAY }),
        makeDrive({ batchTTL: 3 * DAY }), // the one the label must name
      ],
      isSignedOut: false,
    }
    expect(accountDriveAttention(account, measuredAt)).toEqual({
      reason: 'expiring',
      expiry: measuredAt + 3 * DAY_MS,
    })
  })

  it('labels and describes each reason, naming the drive rather than "storage" (#768)', () => {
    const expiring = { reason: 'expiring', expiry: Date.UTC(2026, 9, 2) } as const
    // The label is fixed-width — the row slot reserves for it — so the date
    // only ever shows in the description behind it.
    expect(driveAttentionLabel(expiring)).toBe('Drive expiring')
    expect(driveAttentionLabel({ ...expiring, reason: 'may-expire' })).toBe('Drive expiring')
    expect(driveAttentionLabel({ reason: 'full' })).toBe('Drive full')
    expect(driveAttentionLabel({ reason: 'expired' })).toBe('Drive expired')
    expect(driveAttentionLabel({ ...expiring, reason: 'may-have-expired' })).toBe('Drive expired')
    expect(driveAttentionDescription(expiring, 'home')).toBe(
      'A drive expires on 2026-10-02. Sign in to extend its lifespan.',
    )
    // The sign-out estimate hedges: only the live drives can state a date.
    expect(driveAttentionDescription({ ...expiring, reason: 'may-expire' }, 'home')).toBe(
      'A drive may expire around 2026-10-02. Sign in to check it.',
    )
    expect(driveAttentionDescription({ reason: 'full' }, 'home')).toBe(
      'A drive is full. Sign in to increase its size.',
    )
    expect(driveAttentionDescription({ reason: 'expired' }, 'home')).toBe(
      'A drive has expired. Sign in to check it.',
    )
    expect(driveAttentionDescription({ ...expiring, reason: 'may-have-expired' }, 'home')).toBe(
      'A drive may have expired around 2026-10-02. Sign in to check it.',
    )
    // Only the connect popup promises that the connection is not held up.
    expect(driveAttentionDescription({ reason: 'full' }, 'connect')).toBe(
      'A drive is full. Sign in to increase its size. Connecting does not wait for this.',
    )
  })
})

describe('driveEffectiveBytes', () => {
  it('is what a single writer fits into a batch one depth smaller — one partition lane (#566)', () => {
    expect(driveEffectiveBytes(21)).toBe(
      Utils.getStampEffectiveBytes(20, true, RedundancyLevel.OFF),
    )
    // Encrypted, no erasure coding — not the one-argument table with medium
    // erasure coding baked in.
    expect(driveEffectiveBytes(21)).not.toBe(Utils.getStampEffectiveBytes(20))
  })

  it('labels every size on offer, and the drive card, the same way', () => {
    for (const [depth, bytes] of DRIVE_SIZE_BREAKPOINTS) {
      expect(bytes).toBe(driveEffectiveBytes(depth))
    }
    expect(describeDrive(makeDrive({ depth: 21 })).sizeLabel).toBe(
      formatBytes(driveEffectiveBytes(21)),
    )
  })
})

describe('DRIVE_SIZE_BREAKPOINTS', () => {
  it('starts at the smallest usable depth, dropping 17, 18 (#538) and 19 (#566)', () => {
    const depths = DRIVE_SIZE_BREAKPOINTS.map(([depth]) => depth)
    expect(depths).not.toContain(17)
    expect(depths).not.toContain(18)
    expect(depths).not.toContain(19)
    expect(depths[0]).toBe(MIN_USABLE_BATCH_DEPTH)
    expect(MIN_USABLE_BATCH_DEPTH).toBe(20)
  })

  it('lists the remaining sizes smallest first', () => {
    const depths = DRIVE_SIZE_BREAKPOINTS.map(([depth]) => depth)
    expect(depths).toEqual([...depths].sort((a, b) => a - b))
    expect(depths.length).toBeGreaterThan(1)
  })
})

describe('describeDrive on a scratch drive (#862)', () => {
  it('is never storage full, and so never needs attention for it', () => {
    const full = makeDrive({ utilization: 1 })
    expect(describeDrive(full).storageFull).toBe(true)
    const scratch = { ...full, kind: 'scratch' as const }
    expect(describeDrive(scratch)).toMatchObject({ storageFull: false, scratch: true })
    expect(driveNeedsAttention(scratch)).toBe(false)
  })
})

describe('appsUsingDrive', () => {
  const DRIVE = makeDrive({ batchID: new BatchId('c'.repeat(64)) })
  const OTHER = new BatchId('d'.repeat(64))
  const ACCOUNT = { defaultPostageStampBatchID: DRIVE.batchID }

  it('names the apps whose grant reaches the drive', () => {
    const apps = [
      { appUrl: 'https://default.example', appName: 'Follows default', lastConnectedAt: 1 },
      {
        appUrl: 'https://all.example',
        appName: 'All drives',
        lastConnectedAt: 1,
        drives: 'all' as const,
      },
      {
        appUrl: 'https://listed.example',
        appName: 'Listed',
        lastConnectedAt: 1,
        drives: [DRIVE.batchID],
      },
      {
        appUrl: 'https://elsewhere.example',
        appName: 'Elsewhere',
        lastConnectedAt: 1,
        drives: [OTHER],
      },
    ]
    expect(appsUsingDrive(DRIVE, apps, ACCOUNT)).toEqual([
      'Follows default',
      'All drives',
      'Listed',
    ])
  })

  it('leaves out removed apps', () => {
    const apps = [
      { appUrl: 'https://gone.example', appName: 'Gone', lastConnectedAt: 1, revokedAt: 2 },
    ]
    expect(appsUsingDrive(DRIVE, apps, ACCOUNT)).toEqual([])
  })

  it('does not count the default for a drive that is not it', () => {
    const apps = [{ appUrl: 'https://default.example', appName: 'Default app', lastConnectedAt: 1 }]
    expect(appsUsingDrive(DRIVE, apps, { defaultPostageStampBatchID: OTHER })).toEqual([])
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { Utils } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id'

import { strip0x } from '$lib/crypto/hex'

/**
 * Pure presentation helpers that turn a {@link PostageStamp} (a "drive") into
 * the labels the Storage UI renders: human size, used %, status, friendly
 * remaining-lifespan text, and dates. No network calls — everything derives
 * from fields already on the stamp. `batchTTL` is a remaining-seconds SNAPSHOT
 * measured when the stamp was last written (`updatedAt`, else `createdAt`), so
 * {@link remainingLifespanSeconds} ages it by the elapsed time — without that,
 * the countdown would freeze at the purchase-day value forever.
 */

const MS_PER_SECOND = 1000
const SECONDS_PER_HOUR = 60 * 60
export const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR
const DAYS_PER_MONTH = 30
const DAYS_PER_YEAR = 365
const SECONDS_PER_MONTH = DAYS_PER_MONTH * SECONDS_PER_DAY
const SECONDS_PER_YEAR = DAYS_PER_YEAR * SECONDS_PER_DAY

/** Below this much remaining lifespan a drive is flagged "Expires soon". */
const EXPIRES_SOON_THRESHOLD_SECONDS = 7 * SECONDS_PER_DAY
/** At/above this utilization fraction a drive is flagged "Storage full". */
const STORAGE_FULL_FRACTION = 1

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const
const BYTES_PER_UNIT = 1024
const DECIMAL_UNIT_CEILING = 100

/** A drive's lifespan state, driving badge/colour choices in the UI. */
export type DriveStatus = 'active' | 'expires-soon' | 'expired'

/** Units offered by the drive dialogs' lifespan selects. */
export type LifespanUnit = 'days' | 'months' | 'years'

export const LIFESPAN_UNIT_OPTIONS = [
  { value: 'days', label: 'days' },
  { value: 'months', label: 'months' },
  { value: 'years', label: 'years' },
]

/** A lifespan given as `value` × `unit`, as whole seconds; 0 for empty/invalid input. */
export function lifespanToSeconds(value: number, unit: LifespanUnit): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0
  }
  const unitSeconds =
    unit === 'years' ? SECONDS_PER_YEAR : unit === 'months' ? SECONDS_PER_MONTH : SECONDS_PER_DAY
  return Math.round(value * unitSeconds)
}

/** Everything the Storage UI needs to render one drive, derived in one pass. */
export interface DriveDisplay {
  name: string
  sizeLabel: string
  usedPercent: number
  storageFull: boolean
  status: DriveStatus
  /** "3 months left" — empty when expired or TTL is unknown. */
  timeLeftLabel: string
  /** "2026-09-21" — undefined when expired or TTL is unknown. */
  expiryDate?: string
  purchasedOn: string
}

/**
 * Binary (1024-based) byte formatting, e.g. `512 MB`, `64 GB`, `1.5 GB`.
 * Deliberately diverges from bee-js's decimal `Size.toFormattedString()`
 * (base-1000, "536.871 MB"): the capacity breakpoints are powers of two, so
 * binary units render them as the clean sizes the design shows.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  let value = bytes
  let unitIndex = 0
  while (value >= BYTES_PER_UNIT && unitIndex < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT
    unitIndex++
  }
  // Whole numbers and large values read cleanly without decimals; only small
  // fractional values (e.g. 1.5 GB) keep one decimal place.
  const rounded = value >= DECIMAL_UNIT_CEILING ? Math.round(value) : Math.round(value * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${text} ${BYTE_UNITS[unitIndex]}`
}

/** Coarse "<n> months left"-style countdown from a remaining-seconds value. */
export function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return ''
  }
  const days = seconds / SECONDS_PER_DAY
  if (days >= DAYS_PER_YEAR) {
    return plural(Math.round(days / DAYS_PER_YEAR), 'year')
  }
  if (days >= DAYS_PER_MONTH) {
    return plural(Math.round(days / DAYS_PER_MONTH), 'month')
  }
  if (days >= 1) {
    return plural(Math.round(days), 'day')
  }
  return plural(Math.max(1, Math.round(seconds / SECONDS_PER_HOUR)), 'hour')
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} left`
}

const PERCENT_MAX = 100

/** Effective storage capacity of the batch (`Up to X`), formatted. */
function driveSizeLabel(drive: PostageStamp): string {
  return formatBytes(Utils.getStampEffectiveBytes(drive.depth))
}

/**
 * Used capacity as a 0–100 integer (`drive.utilization` is the 0–1 fraction).
 * 100 is reserved for an actually-full drive: 0.996 would otherwise round up
 * to "100% used" while the storage-full state (utilization >= 1) stays off.
 */
function driveUsedPercent(drive: PostageStamp): number {
  const percent = Math.min(PERCENT_MAX, Math.max(0, Math.round(drive.utilization * PERCENT_MAX)))
  return percent === PERCENT_MAX && drive.utilization < STORAGE_FULL_FRACTION
    ? PERCENT_MAX - 1
    : percent
}

/** Hex chars of the batch ID used in an unnamed drive's fallback label. */
const FALLBACK_NAME_HEX_CHARS = 4

/**
 * A drive's label, falling back to `Drive <batch-ID prefix>` when unnamed.
 * Deriving the fallback from the batch ID (not the list position) keeps it
 * stable when drives are added/removed and identical on every device.
 *
 * Takes the two fields rather than a stamp, so a drive that exists only as a
 * journal entry — bought, not yet recorded — is named the same way it will be
 * once it becomes a stamp.
 */
export function driveLabel(name: string | undefined, batchIdHex: string): string {
  return name?.trim() || `Drive ${strip0x(batchIdHex).slice(0, FALLBACK_NAME_HEX_CHARS)}`
}

/** {@link driveLabel} for a stamp. */
export function driveDisplayName(drive: PostageStamp): string {
  return driveLabel(drive.name, drive.batchID.toHex())
}

/**
 * The drive's remaining lifespan (seconds) at `now`: the stored `batchTTL`
 * snapshot aged by the time elapsed since it was measured — `updatedAt` (set
 * whenever a node operation rewrites `batchTTL`), else `createdAt` (purchase /
 * attach measures it too). Negative once the drive has expired; `undefined`
 * when the TTL was never known.
 */
export function remainingLifespanSeconds(
  drive: PostageStamp,
  now = Date.now(),
): number | undefined {
  if (drive.batchTTL === undefined) {
    return undefined
  }
  const measuredAt = drive.updatedAt ?? drive.createdAt
  return drive.batchTTL - Math.max(0, Math.floor((now - measuredAt) / MS_PER_SECOND))
}

/** Format an epoch-ms instant as `YYYY-MM-DD` (the design's date style). Formats
 * in UTC so a date-only label is stable across timezones (and doesn't shift a day
 * around midnight). */
export function formatYmd(epochMs: number): string {
  const date = new Date(epochMs)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}-${day}`
}

/** One-pass derivation of every display value for a drive row + detail. */
/**
 * Whether a drive should be flagged for the user's attention: about to expire
 * or already full — the conditions of the destructive per-drive badges. An
 * EXPIRED drive is deliberately not "attention": it is gone, not saveable.
 */
export function driveNeedsAttention(drive: PostageStamp, now = Date.now()): boolean {
  const d = describeDrive(drive, now)
  return d.status === 'expires-soon' || (d.status !== 'expired' && d.storageFull)
}

/** How many of the account's LIVE drives need attention (see above). */
export function drivesNeedingAttention(
  account: { stamps: PostageStamp[] },
  now = Date.now(),
): number {
  return account.stamps.filter((drive) => driveNeedsAttention(drive, now)).length
}

/**
 * The soonest estimated expiry (epoch ms) among live, not-yet-expired drives
 * with a known TTL; `undefined` when none qualifies. Captured at sign-out so
 * the "expires soon" warning can keep developing while the stamps themselves
 * are locked away in the encrypted snapshot.
 */
export function soonestDriveExpiry(stamps: PostageStamp[], now = Date.now()): number | undefined {
  const expiries = stamps
    .map((drive) => remainingLifespanSeconds(drive, now))
    .filter((ttl): ttl is number => ttl !== undefined && ttl > 0)
    .map((ttl) => now + ttl * MS_PER_SECOND)
  return expiries.length > 0 ? Math.min(...expiries) : undefined
}

/**
 * Whether the account should carry the "Check storage" warning. Signed in:
 * any live drive needs attention. Signed out: the flag captured at sign-out
 * (storage full / already expiring), or the stored soonest expiry has since
 * drifted inside the expires-soon window — the warning develops over time
 * even though the stamps are unreadable.
 */
export function accountNeedsStorageAttention(
  account: {
    stamps: PostageStamp[]
    isSignedOut: boolean
    storageWarning?: boolean
    soonestDriveExpiry?: number
  },
  now = Date.now(),
): boolean {
  if (account.isSignedOut) {
    return (
      account.storageWarning === true ||
      (account.soonestDriveExpiry !== undefined &&
        account.soonestDriveExpiry - now <= EXPIRES_SOON_THRESHOLD_SECONDS * MS_PER_SECOND)
    )
  }
  return drivesNeedingAttention(account, now) > 0
}

export function describeDrive(drive: PostageStamp, now = Date.now()): DriveDisplay {
  const ttl = remainingLifespanSeconds(drive, now)
  const known = ttl !== undefined
  const expired = known && ttl <= 0
  const expiresSoon = known && ttl > 0 && ttl <= EXPIRES_SOON_THRESHOLD_SECONDS
  const hasLifespan = known && ttl > 0

  return {
    name: driveDisplayName(drive),
    sizeLabel: driveSizeLabel(drive),
    usedPercent: driveUsedPercent(drive),
    storageFull: drive.utilization >= STORAGE_FULL_FRACTION,
    status: expired ? 'expired' : expiresSoon ? 'expires-soon' : 'active',
    timeLeftLabel: hasLifespan ? formatRemaining(ttl) : '',
    expiryDate: hasLifespan ? formatYmd(now + ttl * MS_PER_SECOND) : undefined,
    purchasedOn: formatYmd(drive.createdAt),
  }
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { Utils } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id'

/**
 * Pure presentation helpers that turn a {@link PostageStamp} (a "drive") into
 * the labels the Storage UI renders: human size, used %, status, friendly
 * remaining-lifespan text, and dates. No network calls — everything derives
 * from fields already on the stamp (`batchTTL` is Bee's remaining-seconds view).
 */

const SECONDS_PER_HOUR = 60 * 60
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR
const DAYS_PER_MONTH = 30
const DAYS_PER_YEAR = 365

/** Below this much remaining lifespan a drive is flagged "Expires soon". */
export const EXPIRES_SOON_THRESHOLD_SECONDS = 7 * SECONDS_PER_DAY
/** At/above this utilization fraction a drive is flagged "Storage full". */
const STORAGE_FULL_FRACTION = 1

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const
const BYTES_PER_UNIT = 1024
const DECIMAL_UNIT_CEILING = 100

/** A drive's lifespan state, driving badge/colour choices in the UI. */
export type DriveStatus = 'active' | 'expires-soon' | 'expired'

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

/** Binary (1024-based) byte formatting, e.g. `512 MB`, `64 GB`, `1.5 GB`. */
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

/** Effective storage capacity of the batch (`Up to X`), formatted. */
export function driveSizeLabel(drive: PostageStamp): string {
  return formatBytes(Utils.getStampEffectiveBytes(drive.depth))
}

/** Used capacity as a 0–100 integer (`drive.utilization` is the 0–1 fraction). */
export function driveUsedPercent(drive: PostageStamp): number {
  return Math.min(100, Math.max(0, Math.round(drive.utilization * 100)))
}

/** The drive's label, falling back to a positional `Drive N` when unnamed. */
export function driveDisplayName(drive: PostageStamp, index: number): string {
  return drive.name?.trim() || `Drive ${index + 1}`
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
export function describeDrive(drive: PostageStamp, index: number, now = Date.now()): DriveDisplay {
  const ttl = drive.batchTTL
  const known = ttl !== undefined
  const expired = known && ttl <= 0
  const expiresSoon = known && ttl > 0 && ttl <= EXPIRES_SOON_THRESHOLD_SECONDS
  const hasLifespan = known && ttl > 0

  return {
    name: driveDisplayName(drive, index),
    sizeLabel: driveSizeLabel(drive),
    usedPercent: driveUsedPercent(drive),
    storageFull: drive.utilization >= STORAGE_FULL_FRACTION,
    status: expired ? 'expired' : expiresSoon ? 'expires-soon' : 'active',
    timeLeftLabel: hasLifespan ? formatRemaining(ttl) : '',
    expiryDate: hasLifespan ? formatYmd(now + ttl * 1000) : undefined,
    purchasedOn: formatYmd(drive.createdAt),
  }
}

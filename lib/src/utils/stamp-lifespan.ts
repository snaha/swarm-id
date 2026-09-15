// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A drive's lifetime, from the fields already on its stored record.
 *
 * `batchTTL` is a remaining-seconds SNAPSHOT measured when the record was
 * last written — `updatedAt` (a node operation re-measured it), else
 * `createdAt` (purchase / attach measured it too). Aging it here is what lets
 * the proxy refuse a drive the identity UI already shows as expired, without
 * a network round trip (#745).
 */

const MS_PER_SECOND = 1000

/** The subset of a stamp record the lifetime is derived from. */
export interface StampLifetimeFields {
  batchTTL?: number
  createdAt: number
  updatedAt?: number
}

/**
 * Remaining lifespan in seconds at `now`: negative once expired, `undefined`
 * when the TTL was never measured.
 */
export function remainingLifespanSeconds(
  stamp: StampLifetimeFields,
  now = Date.now(),
): number | undefined {
  if (stamp.batchTTL === undefined) {
    return undefined
  }
  const measuredAt = stamp.updatedAt ?? stamp.createdAt
  return (
    stamp.batchTTL - Math.max(0, Math.floor((now - measuredAt) / MS_PER_SECOND))
  )
}

/**
 * Whether the stored lifetime has run out. An unknown lifetime is not
 * expired: refusing to stamp on missing data would turn every legacy record
 * read-only.
 */
export function isStampExpired(
  stamp: StampLifetimeFields,
  now = Date.now(),
): boolean {
  const remaining = remainingLifespanSeconds(stamp, now)
  return remaining !== undefined && remaining <= 0
}

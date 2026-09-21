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

/** The subset of a stamp record the readiness rule is derived from. */
export interface StampLifetimeFields {
  batchTTL?: number
  createdAt: number
  updatedAt?: number
  /** What the node last said: absent on a record that predates the fields */
  usable?: boolean
  exists?: boolean
}

/** Why the session refuses to stamp with the record, or `undefined` if it will. */
export type StampRefusal = "stamp-expired" | "stamp-not-usable"

/**
 * The readiness rule. Expiry first, because it is the older and the more
 * specific answer; then what the node last said about the batch (#765): a
 * batch it does not have (`exists: false`) or cannot use yet (`usable: false`
 * — a fresh purchase for its first ~30 s, or one the node never accepted)
 * refuses the first stamped write, which a dApp gating on `canUpload` alone
 * met 30 s later as a timeout.
 */
export function stampRefusal(
  stamp: StampLifetimeFields,
  now = Date.now(),
): StampRefusal | undefined {
  if (isStampExpired(stamp, now)) return "stamp-expired"
  if (stamp.usable === false || stamp.exists === false) {
    return "stamp-not-usable"
  }
  return undefined
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

/**
 * Whether two records would age to the same lifetime and refuse the same way
 * — the check a refresh needs to notice a renewal of the SAME batch, which
 * moves only `batchTTL` and `updatedAt`, or a node that has since accepted it.
 */
export function sameStampLifetime(
  a: StampLifetimeFields | undefined,
  b: StampLifetimeFields | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b
  return (
    a.batchTTL === b.batchTTL &&
    (a.updatedAt ?? a.createdAt) === (b.updatedAt ?? b.createdAt) &&
    a.usable === b.usable &&
    a.exists === b.exists
  )
}

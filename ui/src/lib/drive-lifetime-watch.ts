// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Re-read the signed-in account's drives from the chain while the identity
 * site is open (#903), on the schedule the dApp proxy uses for its own
 * lifetime readings (#957): halfway to the nearest stored expiry, no sooner
 * than a minute and no later than six hours, and at the expiry itself when
 * that comes first.
 *
 * A stored `batchTTL` is exact only when it is measured. A price change, a
 * top-up anyone may make, or a resize on another device moves the real
 * lifetime, and the expiry warnings follow the record. Unlike the proxy, which
 * keeps its reading in memory, this writes back through `updateStamp`, the
 * path a drive operation takes, so the record, its clock and the synced
 * account all follow. A write publishes the account, so only a reading that
 * disagrees with the record is written, and only one tab per account reads.
 */
import { type PostageStamp, remainingLifespanSeconds } from '@snaha/swarm-id/internal'

import { type ChainReading, readStampsFromChain, stampPatchFor } from '$lib/payment/postage-onchain'
import type { Account } from '$lib/types'

const MS_PER_SECOND = 1000
export const REREAD_MIN_MS = 60 * MS_PER_SECOND
export const REREAD_MAX_MS = 6 * 60 * 60 * MS_PER_SECOND

/**
 * How far the stored lifetime may be off before a reading is written back:
 * 2% of what the chain says is left, and never less than ten minutes. The
 * stored lifetime is extrapolated at the price of its last write, so the gap
 * grows with every price move since: a run of them, a top-up or a resize
 * crosses it and is written, a single pass's wobble mostly does not.
 */
const LIFETIME_TOLERANCE_RATIO = 0.02
const LIFETIME_TOLERANCE_MIN_SECONDS = 10 * 60

/**
 * A drive this young that the chain does not know is an RPC that has not
 * caught up with its purchase, not a batch gone: marking it gone would make a
 * new drive unusable until the next read.
 */
export const BATCH_GONE_GRACE_MS = 10 * 60 * MS_PER_SECOND

/** When to read the drives again, from the nearest stored expiry */
export function nextRereadMs(stamps: PostageStamp[], now: number): number {
  let untilExpiry = Infinity
  for (const stamp of stamps) {
    const left = remainingLifespanSeconds(stamp, now)
    if (left !== undefined && left > 0) {
      untilExpiry = Math.min(untilExpiry, left * MS_PER_SECOND)
    }
  }
  const halfway = Math.min(Math.max(untilExpiry / 2, REREAD_MIN_MS), REREAD_MAX_MS)
  return Math.min(untilExpiry, halfway)
}

/**
 * Whether a reading says something the record does not, beyond the
 * tolerance. `amount` is not compared: it falls with the lifetime, and is
 * written along with whatever is.
 */
export function differsFromRecord(
  stamp: PostageStamp,
  reading: ChainReading,
  now: number,
): boolean {
  if (reading.depth !== undefined && reading.depth !== stamp.depth) return true
  if (reading.exists !== stamp.exists || reading.usable !== stamp.usable) return true
  // No price to measure by: nothing to compare, and nothing to erase
  if (reading.batchTTL === undefined) return false
  const stored = remainingLifespanSeconds(stamp, now)
  if (stored === undefined) return true
  const tolerance = Math.max(
    LIFETIME_TOLERANCE_MIN_SECONDS,
    LIFETIME_TOLERANCE_RATIO * Math.max(0, reading.batchTTL),
  )
  return Math.abs(Math.max(0, stored) - reading.batchTTL) > tolerance
}

type WatchedAccount = Pick<Account, 'stamps' | 'updateStamp'>

/**
 * Read every live drive of `account()` now, then on the schedule, writing
 * back the readings that differ. A drive the chain no longer has is final, so
 * after the first pass it is not read again. Returns a stop function.
 */
export function watchDriveLifetimes(
  account: () => WatchedAccount | undefined,
  read: (stamps: PostageStamp[]) => Promise<(ChainReading | undefined)[]> = readStampsFromChain,
): () => void {
  let stopped = false
  let first = true
  let timer: ReturnType<typeof setTimeout> | undefined

  async function pass(): Promise<void> {
    const startedAt = Date.now()
    const stamps = (account()?.stamps ?? []).filter((stamp) => first || stamp.exists)
    first = false
    // A read that throws (no chain client) is no answer, as a failed one is
    const readings = await read(stamps).catch(() => stamps.map(() => undefined))
    readings.forEach((reading, index) => {
      if (stopped || !reading) return
      // Compare with the record as it is now, not as it was when the read began
      const target = account()
      const current = target?.stamps.find((stamp) => stamp.batchID.equals(stamps[index].batchID))
      if (!target || !current) return
      // Written meanwhile, by a drive operation or a peer's sync: that came
      // from a reading at least as new as this one, which may predate its
      // transaction
      if ((current.updatedAt ?? current.createdAt) > startedAt) return
      if (!reading.exists && startedAt - current.createdAt < BATCH_GONE_GRACE_MS) return
      const now = Date.now()
      if (differsFromRecord(current, reading, now)) {
        target.updateStamp(current.batchID, stampPatchFor(current, reading, now))
      }
    })
    if (stopped) return
    timer = setTimeout(() => void pass(), nextRereadMs(account()?.stamps ?? [], Date.now()))
  }

  void pass()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/**
 * Run `watch` in one tab at a time: the others queue on a Web Lock and the
 * next takes over when the holder stops or closes. Runs it directly where
 * there are no Web Locks. Returns a stop function.
 */
export function inOneTab(lockName: string, watch: () => () => void): () => void {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return watch()
  }
  const queued = new AbortController()
  let release: (() => void) | undefined
  navigator.locks
    .request(
      lockName,
      { signal: queued.signal },
      () =>
        new Promise<void>((resolve) => {
          const stop = watch()
          release = () => {
            stop()
            resolve()
          }
        }),
    )
    // An AbortError: stopped while still queued
    .catch(() => undefined)
  return () => {
    queued.abort()
    release?.()
  }
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Re-read the signed-in account's drives from the chain while the identity
 * site is open, on the schedule the dApp proxy uses for its own
 * lifetime readings: halfway to the nearest stored expiry, no sooner
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
import {
  type PostageStamp,
  nextRemeasureMs,
  remainingLifespanSeconds,
} from '@snaha/swarm-id/internal'

import { type ChainReading, readStampsFromChain, stampPatchFor } from '$lib/payment/postage-onchain'
import type { Account } from '$lib/types'

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
 * Whether a reading says something the record does not, beyond the
 * tolerance. `amount` is not compared: it falls with the lifetime, and is
 * written along with whatever is.
 */
export function differsFromRecord(
  stamp: PostageStamp,
  reading: ChainReading,
  now: number,
): boolean {
  if (reading.depth !== stamp.depth) return true
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
 * back the readings that differ. Returns a stop function.
 */
export function watchDriveLifetimes(
  account: () => WatchedAccount | undefined,
  read: (stamps: PostageStamp[]) => Promise<(ChainReading | undefined)[]> = readStampsFromChain,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  async function pass(): Promise<void> {
    const stamps = account()?.stamps ?? []
    // A read that throws (no chain client) is no answer, as a failed one is
    const readings = await read(stamps).catch(() => stamps.map(() => undefined))
    readings.forEach((reading, index) => {
      if (stopped || !reading) return
      // Compare with the record as it is now, not as it was when the read began
      const target = account()
      const before = stamps[index]
      const current = target?.stamps.find((stamp) => stamp.batchID.equals(before.batchID))
      if (!target || !current) return
      // Written meanwhile, by a drive operation or a peer's sync: that came
      // from a reading at least as new as this one. Matched on the record's
      // measurement instant, not against our clock, which a peer's need not share
      if ((current.updatedAt ?? current.createdAt) !== (before.updatedAt ?? before.createdAt)) {
        return
      }
      // Depth only grows on chain: a lower one is a reading older than the
      // record (a lagging RPC), and its lifetime is just as stale
      if (reading.depth < current.depth) return
      const now = Date.now()
      if (differsFromRecord(current, reading, now)) {
        target.updateStamp(current.batchID, stampPatchFor(current, reading, now))
      }
    })
    if (stopped) return
    timer = setTimeout(() => void pass(), nextRemeasureMs(account()?.stamps ?? [], Date.now()))
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

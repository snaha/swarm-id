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
 * disagrees with the record is written: price noise within the tolerance is
 * not worth a publish.
 */
import { type PostageStamp, remainingLifespanSeconds } from '@snaha/swarm-id/internal'

import { type ChainReading, readStampFromChain } from '$lib/payment/postage-onchain'
import type { Account } from '$lib/types'

const MS_PER_SECOND = 1000
export const REREAD_MIN_MS = 60 * MS_PER_SECOND
export const REREAD_MAX_MS = 6 * 60 * 60 * MS_PER_SECOND

/**
 * How far a reading may drift from the stored lifetime before it is written
 * back: 2% of what is left, and never less than ten minutes. The price
 * oracle moves at most about 2.4% in six hours, so a steady price writes
 * nothing, while a top-up or a real price move is caught.
 */
const LIFETIME_TOLERANCE_RATIO = 0.02
const LIFETIME_TOLERANCE_MIN_SECONDS = 10 * 60

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

/** Whether a reading says something the record does not, beyond price noise */
export function differsFromRecord(
  stamp: PostageStamp,
  reading: ChainReading,
  now: number,
): boolean {
  if (reading.depth !== stamp.depth) return true
  if (reading.exists !== stamp.exists || reading.usable !== stamp.usable) return true
  const stored = remainingLifespanSeconds(stamp, now)
  if (stored === undefined || reading.batchTTL === undefined) {
    return stored !== reading.batchTTL
  }
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
  read: (stamp: PostageStamp) => Promise<ChainReading | undefined> = (stamp) =>
    readStampFromChain(stamp),
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  async function pass(): Promise<void> {
    const target = account()
    if (target) {
      await Promise.all(
        target.stamps.map(async (stamp) => {
          // A read that throws (no chain client) is no answer, as a failed one is
          const reading = await read(stamp).catch(() => undefined)
          if (stopped || !reading) return
          if (differsFromRecord(stamp, reading, Date.now())) {
            target.updateStamp(stamp.batchID, reading)
          }
        }),
      )
    }
    if (stopped) return
    timer = setTimeout(() => void pass(), nextRereadMs(account()?.stamps ?? [], Date.now()))
  }

  void pass()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

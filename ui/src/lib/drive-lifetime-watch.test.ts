// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id/internal'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  REREAD_MAX_MS,
  REREAD_MIN_MS,
  differsFromRecord,
  inOneTab,
  nextRereadMs,
  watchDriveLifetimes,
} from '$lib/drive-lifetime-watch'
import type { ChainReading } from '$lib/payment/postage-onchain'

const NOW = 1_700_000_000_000
const HOUR_S = 3600
const DAY_S = 24 * HOUR_S
const MS = 1000

function drive(batchHex: string, batchTTL: number | undefined, measuredAt = NOW): PostageStamp {
  return {
    batchID: new BatchId(batchHex),
    signerKey: new PrivateKey('11'.repeat(32)),
    utilization: 0,
    usable: true,
    exists: true,
    depth: 20,
    amount: 1n,
    bucketDepth: 16,
    blockNumber: 1,
    immutableFlag: false,
    createdAt: measuredAt,
    batchTTL,
  }
}

function reading(stamp: PostageStamp, batchTTL?: number): ChainReading {
  return { depth: stamp.depth, amount: 2n, exists: true, usable: true, batchTTL }
}

describe('nextRereadMs', () => {
  it('re-reads halfway to the nearest expiry, within a minute and six hours', () => {
    expect(nextRereadMs([drive('aa'.repeat(32), 2 * HOUR_S)], NOW)).toBe(HOUR_S * MS)
    expect(nextRereadMs([drive('aa'.repeat(32), 30 * DAY_S)], NOW)).toBe(REREAD_MAX_MS)
    // Ninety seconds left: never later than the expiry itself
    expect(nextRereadMs([drive('aa'.repeat(32), 90)], NOW)).toBe(REREAD_MIN_MS)
    expect(nextRereadMs([drive('aa'.repeat(32), 30)], NOW)).toBe(30 * MS)
  })

  it('times the drive nearest its expiry, and falls back to the cap', () => {
    const near = drive('aa'.repeat(32), 4 * HOUR_S)
    const far = drive('bb'.repeat(32), 30 * DAY_S)
    expect(nextRereadMs([far, near], NOW)).toBe(2 * HOUR_S * MS)
    // Unmeasured or already run out: nothing to time but the cap
    expect(nextRereadMs([drive('cc'.repeat(32), undefined)], NOW)).toBe(REREAD_MAX_MS)
    expect(nextRereadMs([drive('cc'.repeat(32), 10, NOW - 60 * MS)], NOW)).toBe(REREAD_MAX_MS)
    expect(nextRereadMs([], NOW)).toBe(REREAD_MAX_MS)
  })
})

describe('differsFromRecord', () => {
  const stamp = drive('aa'.repeat(32), 30 * DAY_S)

  it('lets a small drift in the lifetime pass, as price noise', () => {
    expect(differsFromRecord(stamp, reading(stamp, 30 * DAY_S - 60), NOW)).toBe(false)
  })

  it('writes back a lifetime that moved: a top-up, or a price change', () => {
    expect(differsFromRecord(stamp, reading(stamp, 40 * DAY_S), NOW)).toBe(true)
    expect(differsFromRecord(stamp, reading(stamp, 20 * DAY_S), NOW)).toBe(true)
  })

  it('writes back a resize, a batch run out, and a first measurement', () => {
    expect(differsFromRecord(stamp, { ...reading(stamp, 30 * DAY_S), depth: 22 }, NOW)).toBe(true)
    expect(differsFromRecord(stamp, { ...reading(stamp, 0), usable: false }, NOW)).toBe(true)
    const unmeasured = drive('bb'.repeat(32), undefined)
    expect(differsFromRecord(unmeasured, reading(unmeasured, DAY_S), NOW)).toBe(true)
  })

  it('never erases a stored lifetime for a reading without one (no price)', () => {
    expect(differsFromRecord(stamp, reading(stamp), NOW)).toBe(false)
  })
})

describe('watchDriveLifetimes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  function account(stamps: PostageStamp[]) {
    return { stamps, updateStamp: vi.fn() }
  }

  /** A reader answering each drive with `answer` */
  function reader(answer: (stamp: PostageStamp) => ChainReading | undefined) {
    return vi.fn(async (stamps: PostageStamp[]) => stamps.map(answer))
  }

  it('reads every drive at once, and writes back only one that drifted', async () => {
    const steady = drive('aa'.repeat(32), 30 * DAY_S)
    const toppedUp = drive('bb'.repeat(32), 30 * DAY_S)
    const target = account([steady, toppedUp])
    const read = reader((stamp) => reading(stamp, stamp === toppedUp ? 60 * DAY_S : 30 * DAY_S))
    const stop = watchDriveLifetimes(() => target, read)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0][0]).toHaveLength(2)
    expect(target.updateStamp).toHaveBeenCalledTimes(1)
    expect(target.updateStamp.mock.calls[0][0]).toBe(toppedUp.batchID)
    stop()
  })

  it('re-anchors the stored lifetime when a reading without a price is written', async () => {
    // Measured a day ago: 29 days left now. `updateStamp` restarts the clock,
    // so the patch must carry 29 days, not leave the stored 30 to restart
    const resized = drive('aa'.repeat(32), 30 * DAY_S, NOW - DAY_S * MS)
    const target = account([resized])
    const stop = watchDriveLifetimes(
      () => target,
      reader((stamp) => ({ ...reading(stamp), depth: 22 })),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(target.updateStamp).toHaveBeenCalledTimes(1)
    expect(target.updateStamp.mock.calls[0][1]).toMatchObject({ depth: 22, batchTTL: 29 * DAY_S })
    stop()
  })

  it('drops a reading when the record was written while it was read', async () => {
    const before = drive('aa'.repeat(32), 30 * DAY_S)
    const target = account([before])
    // A drive operation records its own, newer reading while ours is in flight
    const read = vi.fn(async (stamps: PostageStamp[]) => {
      vi.setSystemTime(NOW + MS)
      target.stamps = [{ ...before, depth: 22, updatedAt: NOW + MS }]
      return stamps.map((stamp) => reading(stamp, 30 * DAY_S))
    })
    const stop = watchDriveLifetimes(() => target, read)
    await vi.advanceTimersByTimeAsync(0)
    expect(target.updateStamp).not.toHaveBeenCalled()
    stop()
  })

  it('reads again on the schedule, and stops when told', async () => {
    const target = account([drive('aa'.repeat(32), 2 * HOUR_S)])
    const read = reader((stamp) => reading(stamp, 2 * HOUR_S))
    const stop = watchDriveLifetimes(() => target, read)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOUR_S * MS)
    expect(read).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(REREAD_MAX_MS)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps its schedule through a read that throws', async () => {
    const target = account([drive('aa'.repeat(32), 2 * HOUR_S)])
    const read = vi.fn(async (): Promise<ChainReading[]> => {
      throw new Error('no RPC configured')
    })
    const stop = watchDriveLifetimes(() => target, read)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(HOUR_S * MS)
    expect(read).toHaveBeenCalledTimes(2)
    expect(target.updateStamp).not.toHaveBeenCalled()
    stop()
  })

  it('leaves the record alone when the chain cannot answer', async () => {
    const target = account([drive('aa'.repeat(32), 30 * DAY_S)])
    const stop = watchDriveLifetimes(
      () => target,
      reader(() => undefined),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(target.updateStamp).not.toHaveBeenCalled()
    stop()
  })
})

describe('inOneTab', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A FIFO exclusive lock, as `navigator.locks` grants one name */
  function fakeLocks() {
    let tail: Promise<unknown> = Promise.resolve()
    return {
      request(_name: string, options: { signal: AbortSignal }, callback: () => Promise<void>) {
        const turn = tail.then(() => {
          if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError')
          return callback()
        })
        tail = turn.catch(() => undefined)
        return turn
      },
    }
  }

  it('runs one watcher at a time, and hands over when it stops', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    const stops = [vi.fn(), vi.fn(), vi.fn()]
    const watches = stops.map((stop) => vi.fn(() => stop))
    const [stopFirst, stopSecond, stopThird] = watches.map((watch) => inOneTab('lock', watch))
    await Promise.resolve()
    await Promise.resolve()
    expect(watches.map((watch) => watch.mock.calls.length)).toEqual([1, 0, 0])

    // Stopped while queued: it never runs
    stopSecond()
    stopFirst()
    expect(stops[0]).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(watches[2]).toHaveBeenCalledTimes(1))
    expect(watches[1]).not.toHaveBeenCalled()
    stopThird()
    expect(stops[2]).toHaveBeenCalledTimes(1)
  })
})

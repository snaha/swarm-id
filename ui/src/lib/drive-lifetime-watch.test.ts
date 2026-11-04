// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import { type PostageStamp, REMEASURE_MAX_MS } from '@snaha/swarm-id/internal'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { differsFromRecord, inOneTab, watchDriveLifetimes } from '$lib/drive-lifetime-watch'
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

  it('holds the tolerance at 2% of the reading, and never under ten minutes', () => {
    // 6 h on 30 days is under 2% (14.4 h): noise
    expect(differsFromRecord(stamp, reading(stamp, 30 * DAY_S - 6 * HOUR_S), NOW)).toBe(false)
    // 3% is over it: a price move
    expect(differsFromRecord(stamp, reading(stamp, 30 * DAY_S * 0.97), NOW)).toBe(true)
    // 9 min on 2 h is over 2% but under the ten-minute floor
    const short = drive('cc'.repeat(32), 2 * HOUR_S)
    expect(differsFromRecord(short, reading(short, 2 * HOUR_S - 9 * 60), NOW)).toBe(false)
  })

  it('reads a record that has run out as zero, not as how long ago', () => {
    const runOut = drive('dd'.repeat(32), HOUR_S, NOW - DAY_S * MS)
    expect(differsFromRecord(runOut, reading(runOut, 0), NOW)).toBe(false)
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

  it('drops a reading when a peer whose clock is behind ours wrote meanwhile', async () => {
    const before = drive('aa'.repeat(32), 30 * DAY_S, NOW - DAY_S * MS)
    const target = account([before])
    // The peer's clock is 3 s behind: its top-up lands stamped before our read began
    const read = vi.fn(async (stamps: PostageStamp[]) => {
      vi.setSystemTime(NOW + MS)
      target.stamps = [{ ...before, batchTTL: 60 * DAY_S, updatedAt: NOW - 2 * MS }]
      return stamps.map((stamp) => reading(stamp, 29 * DAY_S))
    })
    const stop = watchDriveLifetimes(() => target, read)
    await vi.advanceTimersByTimeAsync(0)
    expect(target.updateStamp).not.toHaveBeenCalled()
    stop()
  })

  it('drops a reading with a lower depth than the record, as older than it', async () => {
    const resized = { ...drive('aa'.repeat(32), 30 * DAY_S), depth: 21 }
    const target = account([resized])
    // A lagging RPC answers with the depth before the resize, and its lifetime
    const stop = watchDriveLifetimes(
      () => target,
      reader((stamp) => ({ ...reading(stamp, 60 * DAY_S), depth: 20 })),
    )
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
    await vi.advanceTimersByTimeAsync(REMEASURE_MAX_MS)
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

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest'

import { SupersededError, createAttemptTracker } from './attempt'

// A promise settled manually by the test — models a ceremony in flight while
// the user clicks cancel or retry.
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createAttemptTracker', () => {
  it('resolves guarded work while the attempt is current', async () => {
    const attempt = createAttemptTracker().begin()

    await expect(attempt.guard(Promise.resolve('seed'))).resolves.toBe('seed')
    expect(attempt.current).toBe(true)
  })

  it('supports several guarded stages within one attempt', async () => {
    const attempt = createAttemptTracker().begin()

    expect(await attempt.guard(Promise.resolve(1))).toBe(1)
    expect(await attempt.guard(Promise.resolve(2))).toBe(2)
  })

  it('throws SupersededError when superseded while the work ran', async () => {
    const attempts = createAttemptTracker()
    const attempt = attempts.begin()
    const work = deferred<string>()
    const guarded = attempt.guard(work.promise)

    attempts.supersede()
    work.resolve('seed')

    await expect(guarded).rejects.toBeInstanceOf(SupersededError)
    expect(attempt.current).toBe(false)
  })

  it('beginning a new attempt supersedes the one in flight', async () => {
    const attempts = createAttemptTracker()
    const stale = attempts.begin()
    const work = deferred<string>()
    const guarded = stale.guard(work.promise)

    const retry = attempts.begin()
    work.resolve('seed')

    await expect(guarded).rejects.toBeInstanceOf(SupersededError)
    expect(stale.current).toBe(false)
    expect(retry.current).toBe(true)
    await expect(retry.guard(Promise.resolve('fresh'))).resolves.toBe('fresh')
  })

  it('runs onDiscard on the resolved value only when superseded', async () => {
    const attempts = createAttemptTracker()
    const attempt = attempts.begin()
    const onDiscard = vi.fn()

    await attempt.guard(Promise.resolve('kept'), onDiscard)
    expect(onDiscard).not.toHaveBeenCalled()

    const work = deferred<string>()
    const guarded = attempt.guard(work.promise, onDiscard)
    attempts.supersede()
    work.resolve('discarded')

    await expect(guarded).rejects.toBeInstanceOf(SupersededError)
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith('discarded')
  })

  it('propagates a rejection unchanged and never discards', async () => {
    const attempts = createAttemptTracker()
    const attempt = attempts.begin()
    const onDiscard = vi.fn()
    const failure = new Error('ceremony failed')
    const work = deferred<string>()
    const guarded = attempt.guard(work.promise, onDiscard)

    attempts.supersede()
    work.reject(failure)

    await expect(guarded).rejects.toBe(failure)
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('SupersededError is only thrown once current is false', async () => {
    // Catch blocks gate on `attempt.current` instead of instanceof checks —
    // that only swallows the error if the two can never disagree.
    const attempts = createAttemptTracker()
    const attempt = attempts.begin()
    const work = deferred<string>()
    const guarded = attempt.guard(work.promise)

    attempts.supersede()
    work.resolve('seed')

    await guarded.catch((caught: unknown) => {
      expect(caught).toBeInstanceOf(SupersededError)
      expect(attempt.current).toBe(false)
    })
  })
})

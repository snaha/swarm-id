// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { rejectAfter, withTimeout } from "./promise"

describe("rejectAfter", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("rejects with the supplied error message after the timeout elapses", async () => {
    const promise = rejectAfter(100, "boom")
    promise.catch(() => {}) // suppress unhandled-rejection warning until awaited
    vi.advanceTimersByTime(99)
    let settled = false
    promise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    vi.advanceTimersByTime(1)
    await expect(promise).rejects.toThrow("boom")
  })

  it("loses the race when a faster promise resolves first", async () => {
    const winner = Promise.resolve("ok")
    const result = await Promise.race([
      winner,
      rejectAfter(10_000, "should not fire"),
    ])
    expect(result).toBe("ok")
  })

  it("wins the race when the work promise hangs longer than the timeout", async () => {
    const hung = new Promise<string>(() => {}) // never resolves
    const racing = Promise.race([hung, rejectAfter(50, "init timed out")])
    racing.catch(() => {})
    vi.advanceTimersByTime(50)
    await expect(racing).rejects.toThrow("init timed out")
  })
})

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves with the work's value when it settles first", async () => {
    await expect(
      withTimeout(Promise.resolve("ok"), 10_000, "should not fire"),
    ).resolves.toBe("ok")
  })

  it("propagates the work's rejection when it settles first", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("work failed")), 10_000, "timeout"),
    ).rejects.toThrow("work failed")
  })

  it("rejects with the timeout message when the work hangs past the limit", async () => {
    const hung = new Promise<string>(() => {}) // never resolves
    const racing = withTimeout(hung, 50, "read timed out")
    racing.catch(() => {})
    vi.advanceTimersByTime(50)
    await expect(racing).rejects.toThrow("read timed out")
  })

  it("clears the timer on the fast path (no pending timer left to fire)", async () => {
    await expect(
      withTimeout(Promise.resolve("ok"), 1000, "boom"),
    ).resolves.toBe("ok")
    // If the timer had not been cleared, advancing past it would leave an
    // unhandled rejection; `clearTimeout` removes it entirely.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
  })
})

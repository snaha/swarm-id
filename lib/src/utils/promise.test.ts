// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { TimeoutError, sleep, withTimeout } from "./promise"

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

  it("rejects with a TimeoutError so callers can classify without message matching", async () => {
    // The timeout-vs-other-failure distinction is load-bearing control flow
    // (inconclusive → fail safe vs clean miss → resume); an `instanceof` check
    // can't silently break the way a copied message string can.
    const hung = new Promise<string>(() => {})
    const racing = withTimeout(hung, 50, "read timed out")
    racing.catch(() => {})
    vi.advanceTimersByTime(50)
    await expect(racing).rejects.toBeInstanceOf(TimeoutError)
  })

  it("a work rejection is NOT a TimeoutError", async () => {
    let caught: unknown
    await withTimeout(
      Promise.reject(new Error("boom")),
      10_000,
      "timeout",
    ).catch((e: unknown) => {
      caught = e
    })
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(TimeoutError)
  })
})

describe("sleep", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("stays pending until the delay elapses, then resolves", async () => {
    let settled = false
    const pending = sleep(100).then(() => {
      settled = true
    })

    vi.advanceTimersByTime(99)
    await Promise.resolve()
    expect(settled).toBe(false)

    vi.advanceTimersByTime(1)
    await pending
    expect(settled).toBe(true)
  })

  it("leaves no timer behind once it has resolved", async () => {
    const pending = sleep(10)
    vi.advanceTimersByTime(10)
    await pending
    expect(vi.getTimerCount()).toBe(0)
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { rejectAfter } from "./promise"

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

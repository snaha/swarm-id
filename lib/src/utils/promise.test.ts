// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { TimeoutError, sleep, withIdleTimeout, withTimeout } from "./promise"

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

describe("withIdleTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves with the work's value when it settles first", async () => {
    await expect(
      withIdleTimeout(() => Promise.resolve("ok"), 10_000, "should not fire"),
    ).resolves.toBe("ok")
  })

  it("propagates the work's rejection when it settles first", async () => {
    await expect(
      withIdleTimeout(
        () => Promise.reject(new Error("work failed")),
        10_000,
        "timeout",
      ),
    ).rejects.toThrow("work failed")
  })

  it("turns a synchronous throw into a rejection rather than losing the timer", async () => {
    await expect(
      withIdleTimeout(
        () => {
          throw new Error("threw before awaiting")
        },
        10_000,
        "timeout",
      ),
    ).rejects.toThrow("threw before awaiting")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("gives up on work that never reports anything", async () => {
    const racing = withIdleTimeout(
      () => new Promise<string>(() => {}),
      50,
      "stalled",
    )
    racing.catch(() => {})
    vi.advanceTimersByTime(50)
    await expect(racing).rejects.toBeInstanceOf(TimeoutError)
    await expect(racing).rejects.toThrow("stalled")
  })

  // Total elapsed time is not the bound, silence is.
  it("outlives the limit many times over while it keeps reporting", async () => {
    let settle = (value: string) => {
      void value
    }
    const racing = withIdleTimeout(
      (keepAlive) =>
        new Promise<string>((resolve) => {
          settle = resolve
          const tick = (remaining: number) => {
            if (remaining === 0) {
              return
            }
            setTimeout(() => {
              keepAlive()
              tick(remaining - 1)
            }, 40)
          }
          tick(10)
        }),
      50,
      "stalled",
    )
    racing.catch(() => {})
    // 400ms of steady reports, eight times the deadline.
    await vi.advanceTimersByTimeAsync(400)
    settle("done")
    await expect(racing).resolves.toBe("done")
  })

  it("gives up once the reports stop, counting from the last one", async () => {
    const racing = withIdleTimeout(
      (keepAlive) =>
        new Promise<string>(() => {
          setTimeout(keepAlive, 40)
        }),
      50,
      "stalled",
    )
    racing.catch(() => {})
    // 40ms in the report lands; the original deadline would have fired at 50.
    await vi.advanceTimersByTimeAsync(80)
    await vi.advanceTimersByTimeAsync(10)
    await expect(racing).rejects.toThrow("stalled")
  })

  it("leaves no timer behind on the fast path", async () => {
    await expect(
      withIdleTimeout(() => Promise.resolve("ok"), 1000, "boom"),
    ).resolves.toBe("ok")
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
  })

  it("ignores a report that arrives after the work has settled", async () => {
    let report = () => {}
    await expect(
      withIdleTimeout(
        (keepAlive) => {
          report = keepAlive
          return Promise.resolve("ok")
        },
        1000,
        "boom",
      ),
    ).resolves.toBe("ok")
    report()
    expect(vi.getTimerCount()).toBe(0)
  })
})

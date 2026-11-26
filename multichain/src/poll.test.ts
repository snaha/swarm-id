// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { waitFor, withRetries } from "./poll"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("withRetries", () => {
  const options = {
    allowedFailures: 3,
    firstDelayMillis: 1_000,
    lastDelayMillis: 5_000,
  }

  it("returns the first success without waiting", async () => {
    const work = vi.fn().mockResolvedValue("ok")
    await expect(withRetries(work, options)).resolves.toBe("ok")
    expect(work).toHaveBeenCalledTimes(1)
  })

  it("retries with a delay that grows from the first to the last", async () => {
    const work = vi
      .fn()
      .mockRejectedValueOnce(new Error("one"))
      .mockRejectedValueOnce(new Error("two"))
      .mockRejectedValueOnce(new Error("three"))
      .mockResolvedValue("ok")
    const onFailure = vi.fn()
    const result = withRetries(work, { ...options, onFailure })

    await vi.advanceTimersByTimeAsync(999)
    expect(work).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(work).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(work).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(result).resolves.toBe("ok")
    expect(onFailure.mock.calls.map(([, attempt]) => attempt)).toEqual([
      1, 2, 3,
    ])
  })

  it("throws the last error once the allowed failures are spent", async () => {
    const work = vi.fn().mockRejectedValue(new Error("down"))
    const result = withRetries(work, options)
    const settled = expect(result).rejects.toThrow("down")
    await vi.runAllTimersAsync()
    await settled
    expect(work).toHaveBeenCalledTimes(options.allowedFailures + 1)
  })
})

describe("waitFor", () => {
  const options = { attempts: 3, waitMillis: 1_000 }

  it("resolves as soon as the predicate holds", async () => {
    const predicate = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    const result = waitFor(predicate, options)
    await vi.runAllTimersAsync()
    await expect(result).resolves.toBeUndefined()
    expect(predicate).toHaveBeenCalledTimes(2)
  })

  it("treats a throwing predicate as not yet", async () => {
    const predicate = vi
      .fn()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue(true)
    const result = waitFor(predicate, options)
    await vi.runAllTimersAsync()
    await expect(result).resolves.toBeUndefined()
  })

  it("rejects after the last attempt without a trailing wait", async () => {
    const predicate = vi.fn().mockResolvedValue(false)
    const result = waitFor(predicate, options)
    const settled = expect(result).rejects.toThrow("Timed out")
    await vi.advanceTimersByTimeAsync(2_000)
    await settled
    expect(predicate).toHaveBeenCalledTimes(options.attempts)
  })
})

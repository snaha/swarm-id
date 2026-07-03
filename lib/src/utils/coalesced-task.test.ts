// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest"
import { runCoalescedAcrossTabs } from "./coalesced-task"

const LOCK = "test-lock"
const KEY = "test-cooldown-key"
const COOLDOWN_MS = 60_000

function stubLocalStorage(
  initial: Record<string, string> = {},
): Map<string, string> {
  const store = new Map<string, string>(Object.entries(initial))
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  })
  return store
}

/** navigator.locks mock that immediately grants the lock (runs the callback). */
function stubWebLocks(): void {
  vi.stubGlobal("navigator", {
    locks: {
      request: (_name: string, _opts: unknown, cb: () => Promise<void>) => cb(),
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("runCoalescedAcrossTabs", () => {
  it("runs the task when there is no prior timestamp, then stamps it", async () => {
    const store = stubLocalStorage()
    stubWebLocks()
    const task = vi.fn(async () => undefined)

    await runCoalescedAcrossTabs({
      lockName: LOCK,
      cooldownKey: KEY,
      cooldownMs: COOLDOWN_MS,
      task,
    })

    expect(task).toHaveBeenCalledTimes(1)
    expect(Number(store.get(KEY))).toBeGreaterThan(0)
  })

  it("skips the task when another tab ran within the cooldown window", async () => {
    stubLocalStorage({ [KEY]: String(Date.now()) })
    stubWebLocks()
    const task = vi.fn(async () => undefined)

    await runCoalescedAcrossTabs({
      lockName: LOCK,
      cooldownKey: KEY,
      cooldownMs: COOLDOWN_MS,
      task,
    })

    expect(task).not.toHaveBeenCalled()
  })

  it("runs when the last run is older than the cooldown window", async () => {
    stubLocalStorage({ [KEY]: String(Date.now() - COOLDOWN_MS * 2) })
    stubWebLocks()
    const task = vi.fn(async () => undefined)

    await runCoalescedAcrossTabs({
      lockName: LOCK,
      cooldownKey: KEY,
      cooldownMs: COOLDOWN_MS,
      task,
    })

    expect(task).toHaveBeenCalledTimes(1)
  })

  it("runs despite a recent timestamp when force is set", async () => {
    stubLocalStorage({ [KEY]: String(Date.now()) })
    stubWebLocks()
    const task = vi.fn(async () => undefined)

    await runCoalescedAcrossTabs({
      lockName: LOCK,
      cooldownKey: KEY,
      cooldownMs: COOLDOWN_MS,
      force: true,
      task,
    })

    expect(task).toHaveBeenCalledTimes(1)
  })

  it("stamps the timestamp even if the task throws", async () => {
    const store = stubLocalStorage()
    stubWebLocks()
    const task = vi.fn(async () => {
      throw new Error("boom")
    })

    await expect(
      runCoalescedAcrossTabs({
        lockName: LOCK,
        cooldownKey: KEY,
        cooldownMs: COOLDOWN_MS,
        task,
      }),
    ).rejects.toThrow("boom")
    expect(Number(store.get(KEY))).toBeGreaterThan(0)
  })

  it("falls back to running directly when Web Locks are unavailable", async () => {
    stubLocalStorage()
    // no navigator stub → the `navigator.locks` branch is skipped
    const task = vi.fn(async () => undefined)

    await runCoalescedAcrossTabs({
      lockName: LOCK,
      cooldownKey: KEY,
      cooldownMs: COOLDOWN_MS,
      task,
    })

    expect(task).toHaveBeenCalledTimes(1)
  })
})

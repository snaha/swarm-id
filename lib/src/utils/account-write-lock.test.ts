// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { withAccountWriteLock, withBatchStateLock } from "./account-write-lock"

const ACCOUNT = "acct-1"
const BATCH_A = "ab".repeat(32)
const BATCH_B = "cd".repeat(32)

describe("withAccountWriteLock", () => {
  /** Lock names in acquisition order, recorded by the navigator.locks stub. */
  let acquired: string[]

  beforeEach(() => {
    acquired = []
    vi.stubGlobal("navigator", {
      locks: {
        request: (
          name: string,
          _opts: { mode: string },
          cb: () => Promise<unknown>,
        ) => {
          acquired.push(name)
          return cb()
        },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("runs op under the account-keyed lock and propagates its result", async () => {
    const result = await withAccountWriteLock(ACCOUNT, async () => "ok")
    expect(result).toBe("ok")
    expect(acquired).toEqual(["swarm-write-account-acct-1"])
  })

  it("nests the legacy per-batch locks INSIDE the account lock, deduped and sorted", async () => {
    // Rollover transition guard: pre-account-scoped tabs still lock
    // `swarm-write-<batchId>`, so those must be held too — after the account
    // lock (all new-version writers serialize there first, making the nested
    // acquisition order deadlock-free) and in one deterministic order.
    let ranUnderLocks: string[] = []
    await withAccountWriteLock(ACCOUNT, async () => {
      ranUnderLocks = [...acquired]
    }, [BATCH_B, BATCH_A, BATCH_B])
    expect(ranUnderLocks).toEqual([
      "swarm-write-account-acct-1",
      `swarm-write-${BATCH_A}`,
      `swarm-write-${BATCH_B}`,
    ])
  })

  it("rejects an op failure without leaving locks logically held", async () => {
    await expect(
      withAccountWriteLock(ACCOUNT, async () => {
        throw new Error("boom")
      }, [BATCH_A]),
    ).rejects.toThrow("boom")
  })

  it("rejects a missing accountId instead of sharing one global lock", async () => {
    // Interpolating undefined/"" would key EVERY account's writes on the same
    // "swarm-write-account-undefined" lock name.
    await expect(withAccountWriteLock("", async () => "ok")).rejects.toThrow(
      "accountId is required",
    )
    expect(acquired).toEqual([])
  })

  it("falls back to running op directly when Web Locks is unavailable", async () => {
    vi.stubGlobal("navigator", {})
    const result = await withAccountWriteLock(ACCOUNT, async () => 42, [
      BATCH_A,
    ])
    expect(result).toBe(42)
  })
})

describe("withBatchStateLock", () => {
  let acquired: string[]

  beforeEach(() => {
    acquired = []
    vi.stubGlobal("navigator", {
      locks: {
        request: (
          name: string,
          _opts: { mode: string },
          cb: () => Promise<unknown>,
        ) => {
          acquired.push(name)
          return cb()
        },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("takes ONLY the batch's state lock — never the account lock", async () => {
    // Stamper builds must not park behind the account lock, which an unrelated
    // batch's minutes-long upload holds; the batch lock alone orders the build
    // against same-batch flushes (writes nest it inside the account lock).
    await withBatchStateLock(BATCH_A, async () => "ok")

    expect(acquired).toEqual([`swarm-write-${BATCH_A}`])
  })

  it("rejects an empty batch id instead of sharing a global lock", async () => {
    await expect(withBatchStateLock("", async () => "ok")).rejects.toThrow(
      "batchId is required",
    )
  })

  it("runs the op directly when Web Locks are unavailable", async () => {
    vi.stubGlobal("navigator", {})
    await expect(withBatchStateLock(BATCH_A, async () => 42)).resolves.toBe(42)
  })
})

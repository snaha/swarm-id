// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, afterEach } from "vitest"
import { withBatchWriteLock } from "./batch-write-lock"
import { FakeLockManager } from "./fake-web-locks"

const BATCH_ID = "ab".repeat(32)

/** A write that holds the lock until the test lets it go. */
function holdTheLock(): { held: Promise<void>; release: () => void } {
  let release: () => void = () => {}
  const held = withBatchWriteLock(
    BATCH_ID,
    () => new Promise<void>((resolve) => (release = resolve)),
  )
  return { held, release: () => release() }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("withBatchWriteLock", () => {
  describe("with Web Locks", () => {
    it("runs one write to a batch at a time, in order", async () => {
      vi.stubGlobal("navigator", { locks: new FakeLockManager() })
      const first = holdTheLock()
      const second = vi.fn(async () => "second")

      const queued = withBatchWriteLock(BATCH_ID, second)
      await Promise.resolve()
      expect(second).not.toHaveBeenCalled()

      first.release()
      await first.held
      expect(await queued).toBe("second")
    })

    it("rejects with aborted, at once, when its signal aborts while it queues", async () => {
      vi.stubGlobal("navigator", { locks: new FakeLockManager() })
      const first = holdTheLock()
      const controller = new AbortController()
      const reason = new Error("left the page")
      const op = vi.fn(async () => {})
      const outcome = vi.fn()

      withBatchWriteLock(BATCH_ID, op, controller.signal).then(outcome, outcome)
      controller.abort(reason)

      await vi.waitFor(() =>
        expect(outcome).toHaveBeenCalledWith(
          expect.objectContaining({ code: "aborted", cause: reason }),
        ),
      )
      first.release()
      await first.held
      expect(op).not.toHaveBeenCalled()
    })

    it("lets the next write in line through when one leaves the queue", async () => {
      vi.stubGlobal("navigator", { locks: new FakeLockManager() })
      const first = holdTheLock()
      const controller = new AbortController()
      const leaving = withBatchWriteLock(
        BATCH_ID,
        async () => {},
        controller.signal,
      ).catch(() => {})
      const third = withBatchWriteLock(BATCH_ID, async () => "third")

      controller.abort()
      await leaving
      first.release()

      expect(await third).toBe("third")
    })
  })

  describe("without Web Locks", () => {
    it("runs the write", async () => {
      expect(await withBatchWriteLock(BATCH_ID, async () => "ran")).toBe("ran")
    })

    it("refuses a write whose signal has already aborted", async () => {
      const op = vi.fn(async () => {})

      await expect(
        withBatchWriteLock(BATCH_ID, op, AbortSignal.abort()),
      ).rejects.toMatchObject({ code: "aborted" })
      expect(op).not.toHaveBeenCalled()
    })
  })
})

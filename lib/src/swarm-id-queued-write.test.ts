// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the bridge says while a write is under way, between a real client and
 * a real proxy: that it is still queued for its drive, and how far it has got.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Rollup-only virtual module (see rollup.config.js) — not resolvable in vitest
vi.mock("virtual:stamp-worker-code", () => ({ default: "" }))

import {
  BRIDGE_GATEWAY_URL,
  openBridge,
  type Bridge,
} from "./bridge-test-utils"
import { CHUNK_SIZE } from "./proxy/chunking"
import { PROGRESS_INTERVAL_MS } from "./utils/constants"
import { DriveWritePath } from "./proxy/drive-write-path"
import type { UploadTarget } from "./proxy/upload"
import type {
  BatchWriteCoordinator,
  WithWriteOptions,
} from "./sync/batch-write-coordinator"
import type { UtilizationAwareStamper } from "./utils/batch-utilization"
import { withBatchWriteLock } from "./utils/batch-write-lock"
import { FakeLockManager } from "./utils/fake-web-locks"

const SETTLE_MS = 20

type ClientInternals = { pendingRequests: Map<string, unknown> }
type ProxyInternals = {
  inFlightRequests: Map<string, AbortController>
  drives: Map<string, DriveWritePath>
  primaryBatchId: string | undefined
}

function makeData(length: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(length)
  for (let i = 0; i < length; i++) data[i] = (i * 31 + (i >> 12)) & 0xff
  return data
}

describe("a write across the bridge", () => {
  let bridge: Bridge
  let proxy: ProxyInternals

  beforeEach(async () => {
    vi.restoreAllMocks()
    bridge = await openBridge()
    proxy = bridge.proxy as unknown as ProxyInternals
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const expectNothingLeftBehind = () => {
    const client = bridge.client as unknown as ClientInternals
    expect(client.pendingRequests.size).toBe(0)
    expect(proxy.inFlightRequests.size).toBe(0)
  }

  /** Make the gateway keep every chunk waiting until `release` is called. */
  const holdTheGateway = () => {
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => (release = resolve))
    bridge.gateway.hold = () => released
    return release
  }

  describe("queued behind another write to the same drive", () => {
    const BATCH_ID = "cd".repeat(32)
    const SIGNER_KEY = "ef".repeat(32)
    const QUEUED_TIMEOUT_MS = 10_000
    /** Longer than the queued write's own timeout, shorter than the holder's. */
    const HELD_MS = 3 * QUEUED_TIMEOUT_MS

    beforeEach(() => {
      vi.stubGlobal("navigator", { locks: new FakeLockManager() })
      // A drive whose writes queue on its cross-tab lock, as a coordinator's
      // do, and land on the stand-in node.
      const drive = new DriveWritePath(BATCH_ID, SIGNER_KEY, { createdAt: 0 })
      const coordinator = {
        withWrite: <T>(
          op: (target: UploadTarget) => Promise<T>,
          opts?: WithWriteOptions,
        ) =>
          withBatchWriteLock(
            BATCH_ID,
            () => op({ mode: "subsidised", gatewayUrl: BRIDGE_GATEWAY_URL }),
            opts?.signal,
          ),
      }
      drive.attach(
        {} as UtilizationAwareStamper,
        "test-fingerprint",
        coordinator as unknown as BatchWriteCoordinator,
      )
      proxy.drives.set(BATCH_ID, drive)
      proxy.primaryBatchId = BATCH_ID
    })

    it("waits its turn past its own timeout, and lands after it", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      })
      const release = holdTheGateway()
      const finished: string[] = []
      const first = bridge.client
        .uploadData(makeData(CHUNK_SIZE))
        .then((result) => {
          finished.push("holder")
          return result
        })
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      const second = bridge.client
        .uploadData(makeData(CHUNK_SIZE + 1), undefined, {
          timeout: QUEUED_TIMEOUT_MS,
        })
        .then((result) => {
          finished.push("queued")
          return result
        })
      const secondSettled = vi.fn()
      second.then(secondSettled, secondSettled)

      await vi.advanceTimersByTimeAsync(HELD_MS)
      expect(secondSettled).not.toHaveBeenCalled()

      release()
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      await Promise.all([first, second])
      expect(finished).toEqual(["holder", "queued"])
      // The heartbeat stopped with the wait.
      expect(vi.getTimerCount()).toBe(0)
      expectNothingLeftBehind()
    })

    it("leaves the queue at once when aborted, and spends nothing", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      })
      const release = holdTheGateway()
      const first = bridge.client.uploadData(makeData(CHUNK_SIZE))
      await vi.waitFor(() => expect(bridge.fetchSpy).toHaveBeenCalledTimes(1))
      const controller = new AbortController()
      const second = bridge.client.uploadData(makeData(CHUNK_SIZE), undefined, {
        signal: controller.signal,
      })
      await vi.advanceTimersByTimeAsync(SETTLE_MS)

      controller.abort()
      await expect(second).rejects.toMatchObject({ code: "aborted" })
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      expect(proxy.inFlightRequests.size).toBe(1)

      release()
      await first
      // The holder's chunk only: the aborted write sent none of its own.
      expect(bridge.fetchSpy).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      expectNothingLeftBehind()
    })

    it("stops in the proxy when it times out while it runs", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      })
      bridge.gateway.hangs = true
      const upload = bridge.client.uploadData(makeData(CHUNK_SIZE), undefined, {
        timeout: QUEUED_TIMEOUT_MS,
      })
      const rejected = expect(upload).rejects.toMatchObject({ code: "timeout" })

      await vi.advanceTimersByTimeAsync(QUEUED_TIMEOUT_MS + SETTLE_MS)

      await rejected
      expectNothingLeftBehind()
    })
  })

  describe("upload progress", () => {
    /** 200 leaves, the two intermediates over them, and the root. */
    const LEAVES = 200
    const CHUNKS = LEAVES + 2 + 1
    const STALL_AT_CHUNK = LEAVES / 2

    /**
     * The clock and the throttle's trailing timer only move when a test
     * advances them, so how fast the machine runs the upload changes nothing.
     */
    const fakeTheThrottle = () =>
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })

    it("is posted once an interval at most, and the last report always", async () => {
      fakeTheThrottle()
      const progress: Array<{ total: number; processed: number }> = []

      await bridge.client.uploadData(makeData(CHUNK_SIZE * LEAVES), {
        onProgress: (p) => progress.push(p),
      })

      expect(progress.length).toBeLessThanOrEqual(2)
      expect(progress.at(-1)).toEqual({ total: CHUNKS, processed: CHUNKS })
    })

    it("posts a held-back report once the interval is up, while the upload stalls", async () => {
      fakeTheThrottle()
      const progress: Array<{ total: number; processed: number }> = []
      let reachStall: () => void = () => {}
      const stallReached = new Promise<void>((r) => (reachStall = r))
      let release: () => void = () => {}
      const stalled = new Promise<void>((r) => (release = r))
      bridge.gateway.hold = (chunkNumber) => {
        if (chunkNumber !== STALL_AT_CHUNK) return
        reachStall()
        return stalled
      }

      const upload = bridge.client.uploadData(makeData(CHUNK_SIZE * LEAVES), {
        onProgress: (p) => progress.push(p),
      })
      await stallReached
      await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS + SETTLE_MS)

      expect(progress.length).toBe(2)
      expect(progress[1].processed).toBe(STALL_AT_CHUNK - 1)
      release()
      await upload
    })
  })
})

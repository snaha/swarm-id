// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChunkUploadStream } from "./chunk-upload-stream"
import { uploadData } from "./upload"
import { MockBee, createMockStamper } from "./feeds/epochs/test-utils"

const BEE_URL = "http://bee.example"
const TAG_UID = 7
const NORMAL_CLOSURE = 1000
const ABNORMAL_CLOSURE = 1006
/** Every wait below ends at once or never: a hang fails here, not at 5 s. */
const HANG_MS = 500

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static last: FakeWebSocket | undefined
  static staysConnecting = false

  readyState = 0
  binaryType = ""
  sent = 0
  onopen: (() => void) | undefined
  onerror: (() => void) | undefined
  onmessage: (() => void) | undefined
  onclose: ((event: { code: number; reason: string }) => void) | undefined

  constructor(readonly url: string) {
    FakeWebSocket.last = this
    queueMicrotask(() => {
      if (FakeWebSocket.staysConnecting) return
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }

  send(): void {
    this.sent++
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: NORMAL_CLOSURE, reason: "" })
  }

  /** What a browser reports for any failed connection: an error, then a close, no reason. */
  fail(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onerror?.()
    this.onclose?.({ code: ABNORMAL_CLOSURE, reason: "" })
  }
}

beforeEach(() => {
  FakeWebSocket.last = undefined
  FakeWebSocket.staysConnecting = false
  vi.stubGlobal("WebSocket", FakeWebSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("ChunkUploadStream", () => {
  it(
    "rejects what awaits an ack at the abort and closes the socket",
    async () => {
      const controller = new AbortController()
      const stream = new ChunkUploadStream(BEE_URL, {
        concurrency: 1,
        signal: controller.signal,
      })
      await stream.open()
      const sent = stream.uploadChunk(new Uint8Array(1))
      const waiting = stream.uploadChunk(new Uint8Array(1))

      controller.abort()

      await expect(sent).rejects.toMatchObject({ code: "aborted" })
      await expect(waiting).rejects.toMatchObject({ code: "aborted" })
      await stream.close()
      expect(FakeWebSocket.last?.readyState).toBe(FakeWebSocket.CLOSED)
    },
    HANG_MS,
  )

  it(
    "rejects open() at an abort during the connect",
    async () => {
      FakeWebSocket.staysConnecting = true
      const controller = new AbortController()
      const stream = new ChunkUploadStream(BEE_URL, {
        signal: controller.signal,
      })
      const opening = stream.open()

      controller.abort()

      await expect(opening).rejects.toMatchObject({ code: "aborted" })
      expect(FakeWebSocket.last?.readyState).toBe(FakeWebSocket.CLOSED)
    },
    HANG_MS,
  )

  it(
    "keeps the failed connect's message after the close that follows it",
    async () => {
      FakeWebSocket.staysConnecting = true
      const stream = new ChunkUploadStream(BEE_URL)
      const opening = stream.open()

      FakeWebSocket.last?.fail()

      await expect(opening).rejects.toThrow("Could not open")
      await expect(stream.uploadChunk(new Uint8Array(1))).rejects.toThrow(
        "Could not open",
      )
    },
    HANG_MS,
  )

  it(
    "reports a mid-stream error to later chunks, as it did to the ones in flight",
    async () => {
      const stream = new ChunkUploadStream(BEE_URL)
      await stream.open()
      const inFlight = stream.uploadChunk(new Uint8Array(1))

      FakeWebSocket.last?.fail()

      await expect(inFlight).rejects.toThrow("WebSocket connection error")
      await expect(stream.uploadChunk(new Uint8Array(1))).rejects.toThrow(
        "WebSocket connection error",
      )
    },
    HANG_MS,
  )

  it(
    "close() returns once an ack has timed out",
    async () => {
      const stream = new ChunkUploadStream(BEE_URL)
      await stream.open()
      vi.useFakeTimers()
      const sent = stream.uploadChunk(new Uint8Array(1))
      const timedOut = expect(sent).rejects.toThrow("ack timeout")

      await vi.runOnlyPendingTimersAsync()

      await timedOut
      await stream.close()
    },
    HANG_MS,
  )
})

describe("a WebSocket upload", () => {
  it(
    "rejects at the abort without waiting for the acks",
    async () => {
      const controller = new AbortController()
      const upload = uploadData(
        {
          mode: "stamper",
          bee: new MockBee(),
          stamper: createMockStamper(),
          signal: controller.signal,
        },
        new Uint8Array(1),
        {
          encryptionKey: true,
          tag: TAG_UID,
          webSocket: { concurrency: 1 },
        },
      )
      await vi.waitFor(() => expect(FakeWebSocket.last?.sent).toBe(1))

      controller.abort()

      await expect(upload).rejects.toMatchObject({ code: "aborted" })
      expect(FakeWebSocket.last?.readyState).toBe(FakeWebSocket.CLOSED)
    },
    HANG_MS,
  )
})

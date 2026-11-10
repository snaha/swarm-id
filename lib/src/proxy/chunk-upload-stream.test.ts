// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChunkUploadStream } from "./chunk-upload-stream"
import { uploadData, type UploadTarget } from "./upload"
import { MockBee, createMockStamper } from "./feeds/epochs/test-utils"

const BEE_URL = "http://bee.example"
const TAG_UID = 7
const NORMAL_CLOSURE = 1000
/** Splits into three leaves under one parent, plain or encrypted */
const THREE_LEAVES_SIZE = 9_000
const THREE_LEAVES_AND_PARENT = 4
/** Every wait below ends at once or never: a hang fails here, not at 5 s. */
const HANG_MS = 500

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static last: FakeWebSocket | undefined
  static staysConnecting = false
  static refuses = false
  static acks = false

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
      if (FakeWebSocket.refuses) {
        this.onerror?.()
        return
      }
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }

  send(): void {
    this.sent++
    if (FakeWebSocket.acks) queueMicrotask(() => this.onmessage?.())
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: NORMAL_CLOSURE, reason: "" })
  }
}

beforeEach(() => {
  FakeWebSocket.last = undefined
  FakeWebSocket.staysConnecting = false
  FakeWebSocket.refuses = false
  FakeWebSocket.acks = false
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

function spiedStamperTarget(): {
  target: UploadTarget
  chunkUpload: ReturnType<typeof vi.fn>
  tagCreate: ReturnType<typeof vi.fn>
} {
  const bee = new MockBee()
  const chunkUpload = vi.fn(bee.chunk.upload)
  bee.chunk.upload = chunkUpload
  const tagCreate = vi.fn(bee.tag.create)
  bee.tag.create = tagCreate
  return {
    target: { mode: "stamper", bee, stamper: createMockStamper() },
    chunkUpload,
    tagCreate,
  }
}

describe.each([
  { kind: "plain", encryption: {} },
  { kind: "encrypted", encryption: { encryptionKey: true as const } },
])("a $kind WebSocket upload", ({ encryption }) => {
  it(
    "sends every chunk over the stream and none over HTTP",
    async () => {
      FakeWebSocket.acks = true
      const { target, chunkUpload } = spiedStamperTarget()

      await uploadData(target, new Uint8Array(THREE_LEAVES_SIZE), {
        ...encryption,
        webSocket: {},
      })

      expect(FakeWebSocket.last?.url).toContain("/chunks/stream")
      expect(FakeWebSocket.last?.sent).toBe(THREE_LEAVES_AND_PARENT)
      expect(FakeWebSocket.last?.readyState).toBe(FakeWebSocket.CLOSED)
      expect(chunkUpload).not.toHaveBeenCalled()
    },
    HANG_MS,
  )

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
          ...encryption,
          deferred: true,
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

  it(
    "tags the stream of a deferred upload",
    async () => {
      FakeWebSocket.acks = true
      const { target } = spiedStamperTarget()

      const { tagUid } = await uploadData(target, new Uint8Array(1), {
        ...encryption,
        deferred: true,
        tag: TAG_UID,
        webSocket: {},
      })

      expect(FakeWebSocket.last?.url).toContain(`swarm-tag=${TAG_UID}`)
      expect(tagUid).toBe(TAG_UID)
    },
    HANG_MS,
  )

  // Bee defers a stream's chunks exactly when the stream has a tag.
  it.each([
    { title: "an explicit tag", tagOption: { tag: TAG_UID } },
    { title: "no tag", tagOption: {} },
  ])(
    "leaves the stream of a direct upload untagged, given $title",
    async ({ tagOption }) => {
      FakeWebSocket.acks = true
      const { target, tagCreate } = spiedStamperTarget()

      const { tagUid } = await uploadData(target, new Uint8Array(1), {
        ...encryption,
        ...tagOption,
        webSocket: {},
      })

      expect(FakeWebSocket.last?.url).not.toContain("swarm-tag")
      expect(tagUid).toBeUndefined()
      expect(tagCreate).not.toHaveBeenCalled()
    },
    HANG_MS,
  )

  it(
    "refuses to pin, which the stream cannot do",
    async () => {
      const { target, chunkUpload } = spiedStamperTarget()

      await expect(
        uploadData(target, new Uint8Array(1), {
          ...encryption,
          pin: true,
          webSocket: {},
        }),
      ).rejects.toMatchObject({ code: "invalid-request" })

      expect(FakeWebSocket.last).toBeUndefined()
      expect(chunkUpload).not.toHaveBeenCalled()
    },
    HANG_MS,
  )

  it(
    "fails on a refused upgrade instead of falling back to HTTP",
    async () => {
      FakeWebSocket.refuses = true
      const { target, chunkUpload } = spiedStamperTarget()

      await expect(
        uploadData(target, new Uint8Array(1), {
          ...encryption,
          webSocket: {},
        }),
      ).rejects.toThrow("/chunks/stream")

      expect(chunkUpload).not.toHaveBeenCalled()
    },
    HANG_MS,
  )
})

describe("a plain WebSocket upload", () => {
  it(
    "reaches the reference the HTTP path reaches",
    async () => {
      FakeWebSocket.acks = true
      const data = new Uint8Array(THREE_LEAVES_SIZE).fill(1)

      const overHttp = await uploadData(spiedStamperTarget().target, data)
      const overStream = await uploadData(spiedStamperTarget().target, data, {
        webSocket: {},
      })

      expect(overStream.reference).toBe(overHttp.reference)
    },
    HANG_MS,
  )

  it(
    "reports progress for every chunk",
    async () => {
      FakeWebSocket.acks = true
      const seen: Array<{ total: number; processed: number }> = []

      await uploadData(
        spiedStamperTarget().target,
        new Uint8Array(THREE_LEAVES_SIZE),
        { webSocket: {}, onProgress: (progress) => seen.push(progress) },
      )

      expect(seen.at(-1)).toEqual({
        total: THREE_LEAVES_AND_PARENT,
        processed: THREE_LEAVES_AND_PARENT,
      })
    },
    HANG_MS,
  )
})

describe("a subsidised upload", () => {
  it(
    "stays on the gateway's HTTP and opens no stream",
    async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ reference: "ab".repeat(32) })),
      )
      vi.stubGlobal("fetch", fetchMock)

      await uploadData(
        { mode: "subsidised", gatewayUrl: BEE_URL },
        new Uint8Array(1),
        { webSocket: {} },
      )

      expect(FakeWebSocket.last).toBeUndefined()
      expect(fetchMock).toHaveBeenCalledOnce()
    },
    HANG_MS,
  )
})

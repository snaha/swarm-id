// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChunkUploadStream } from "./chunk-upload-stream"
import { uploadData, type UploadTarget } from "./upload"
import { MockBee, createMockStamper } from "./feeds/epochs/test-utils"

const BEE_URL = "http://bee.example"
const TAG_UID = 7
const NORMAL_CLOSURE = 1000
const ABNORMAL_CLOSURE = 1006
const NOT_FOUND = 404
const INTERNAL_SERVER_ERROR = 500
/** Splits into three leaves under one parent, plain or encrypted */
const THREE_LEAVES_SIZE = 9_000
const THREE_LEAVES_AND_PARENT = 4
/** Twenty leaves: far more chunks than a failure should let through */
const MANY_LEAVES_SIZE = 4096 * 20
/** Every wait below ends at once or never: a hang fails here, not at 5 s. */
const HANG_MS = 500

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static last: FakeWebSocket | undefined
  static staysConnecting = false
  static refuses = false
  static acks = false
  /** The send, counted from 1, that throws as a full buffer would */
  static throwsOnSend: number | undefined

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
    if (this.sent === FakeWebSocket.throwsOnSend) throw new Error("send failed")
    if (FakeWebSocket.acks) queueMicrotask(() => this.onmessage?.())
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
  FakeWebSocket.refuses = false
  FakeWebSocket.acks = false
  FakeWebSocket.throwsOnSend = undefined
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
  it(
    "leaves the stream of a direct upload untagged",
    async () => {
      FakeWebSocket.acks = true
      const { target, tagCreate } = spiedStamperTarget()

      const { tagUid } = await uploadData(target, new Uint8Array(1), {
        ...encryption,
        webSocket: {},
      })

      expect(FakeWebSocket.last?.url).not.toContain("swarm-tag")
      expect(tagUid).toBeUndefined()
      expect(tagCreate).not.toHaveBeenCalled()
    },
    HANG_MS,
  )

  it.each([
    { title: "to pin, which the stream cannot do", conflict: { pin: true } },
    {
      title: "a tag without deferred, which would defer the stream",
      conflict: { tag: TAG_UID },
    },
  ])(
    "refuses $title",
    async ({ conflict }) => {
      const { target, chunkUpload, tagCreate } = spiedStamperTarget()

      await expect(
        uploadData(target, new Uint8Array(1), {
          ...encryption,
          ...conflict,
          webSocket: {},
        }),
      ).rejects.toMatchObject({ code: "invalid-request" })

      expect(FakeWebSocket.last).toBeUndefined()
      expect(chunkUpload).not.toHaveBeenCalled()
      expect(tagCreate).not.toHaveBeenCalled()
    },
    HANG_MS,
  )

  it(
    "refuses a deferred upload on a node without tags, before any stream",
    async () => {
      const { target, chunkUpload, tagCreate } = spiedStamperTarget()
      tagCreate.mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: NOT_FOUND }),
      )

      await expect(
        uploadData(target, new Uint8Array(1), {
          ...encryption,
          deferred: true,
          webSocket: {},
        }),
      ).rejects.toMatchObject({ code: "invalid-request" })

      expect(FakeWebSocket.last).toBeUndefined()
      expect(chunkUpload).not.toHaveBeenCalled()
    },
    HANG_MS,
  )

  it(
    "rejects a deferred upload with Bee's own error when making its tag fails",
    async () => {
      const { target, chunkUpload, tagCreate } = spiedStamperTarget()
      const failure = Object.assign(new Error("Internal Server Error"), {
        status: INTERNAL_SERVER_ERROR,
      })
      tagCreate.mockRejectedValue(failure)

      const error = await uploadData(target, new Uint8Array(1), {
        ...encryption,
        deferred: true,
        webSocket: {},
      }).catch((e: unknown) => e)

      expect(error).toBe(failure)
      expect(error).not.toMatchObject({ code: "invalid-request" })
      expect(FakeWebSocket.last).toBeUndefined()
      expect(chunkUpload).not.toHaveBeenCalled()
    },
    HANG_MS,
  )

  // Bee reads tag 0 as no tag: `Deferred: tag != 0`.
  it(
    "reads tag 0 as no tag, creating one for a deferred upload",
    async () => {
      FakeWebSocket.acks = true
      const { target, tagCreate } = spiedStamperTarget()

      const { tagUid } = await uploadData(target, new Uint8Array(1), {
        ...encryption,
        deferred: true,
        tag: 0,
        webSocket: {},
      })

      expect(tagCreate).toHaveBeenCalledOnce()
      expect(tagUid).not.toBe(0)
      expect(FakeWebSocket.last?.url).toContain(`swarm-tag=${tagUid}`)
    },
    HANG_MS,
  )

  it(
    "reads tag 0 as no tag, refusing nothing on a direct upload",
    async () => {
      FakeWebSocket.acks = true
      const { target } = spiedStamperTarget()

      const { tagUid } = await uploadData(target, new Uint8Array(1), {
        ...encryption,
        tag: 0,
        webSocket: {},
      })

      expect(tagUid).toBeUndefined()
      expect(FakeWebSocket.last?.url).not.toContain("swarm-tag")
    },
    HANG_MS,
  )

  it(
    "stops sending once a chunk fails",
    async () => {
      FakeWebSocket.acks = true
      FakeWebSocket.throwsOnSend = 3
      const { target } = spiedStamperTarget()

      await expect(
        uploadData(target, new Uint8Array(MANY_LEAVES_SIZE), {
          ...encryption,
          webSocket: { concurrency: 2 },
        }),
      ).rejects.toThrow("send failed")
      await new Promise((resolve) => setTimeout(resolve, 0))

      // The failed send and the one other worker's last.
      expect(FakeWebSocket.last?.sent).toBeLessThanOrEqual(4)
    },
    HANG_MS,
  )

  it(
    "rejects with the chunk's failure, not with the stream's closing",
    async () => {
      FakeWebSocket.throwsOnSend = 2
      const { target } = spiedStamperTarget()

      await expect(
        uploadData(target, new Uint8Array(MANY_LEAVES_SIZE), {
          ...encryption,
          webSocket: { concurrency: 2 },
        }),
      ).rejects.toThrow("send failed")
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

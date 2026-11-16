// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A real `SwarmIdClient` wired to a real `SwarmIdProxy` over the two
 * `postMessage` seams, each message run through `structuredClone` with its
 * transfer list and validated by the receiving side's schema, as the browser
 * would. Only the Bee node is a stand-in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Rollup-only virtual module (see rollup.config.js) — not resolvable in vitest
vi.mock("virtual:stamp-worker-code", () => ({ default: "" }))

import { Binary } from "cafe-utility"
import { SwarmIdClient } from "./swarm-id-client"
import { SwarmIdProxy } from "./swarm-id-proxy"
import {
  IframeToParentMessageSchema,
  type IframeToParentMessage,
} from "./types"
import { calculateChunkAddress } from "./chunk"
import {
  CHUNK_SIZE,
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_PIECE_SIZE,
} from "./proxy/chunking"
import { PROGRESS_INTERVAL_MS } from "./utils/constants"
import { MockBee, MockChunkStore } from "./proxy/feeds/epochs/test-utils"
import { DriveWritePath } from "./proxy/drive-write-path"
import { uploadCollection } from "./proxy/collection"
import type { UploadTarget } from "./proxy/upload"
import type {
  BatchWriteCoordinator,
  WithWriteOptions,
} from "./sync/batch-write-coordinator"
import type { UtilizationAwareStamper } from "./utils/batch-utilization"
import { withBatchWriteLock } from "./utils/batch-write-lock"
import { FakeLockManager } from "./utils/fake-web-locks"

const PARENT_ORIGIN = "https://dapp.example.com"
const IFRAME_ORIGIN = "https://id.example.com"
const GATEWAY_URL = "https://gateway.example.com"
const APP_SECRET_HEX = "ab".repeat(32)
/** Beyond what any test here needs to finish; expiry shows as a failure. */
const GENEROUS_TIMEOUT_MS = 60_000
const SETTLE_MS = 20

type ClientInternals = {
  ready: boolean
  iframe: unknown
  handleIframeMessage: (message: IframeToParentMessage) => void
  pendingRequests: Map<string, unknown>
  downloadStreams: Map<string, unknown>
}
type ProxyInternals = {
  authenticated: boolean
  appSecret: string
  inFlightRequests: Map<string, AbortController>
  uploadSources: Map<string, unknown>
  downloadPulls: Map<string, unknown>
  drives: Map<string, DriveWritePath>
  primaryBatchId: string | undefined
}

function makeData(length: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(length)
  for (let i = 0; i < length; i++) data[i] = (i * 31 + (i >> 12)) & 0xff
  return data
}

function streamOf(
  data: Uint8Array,
  pieceSize: number,
): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset >= data.length) return controller.close()
        controller.enqueue(data.slice(offset, offset + pieceSize))
        offset += pieceSize
      },
    },
    { highWaterMark: 0 },
  )
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const pieces: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pieces.push(value)
  }
  const whole = new Uint8Array(pieces.reduce((sum, p) => sum + p.length, 0))
  let offset = 0
  for (const piece of pieces) {
    whole.set(piece, offset)
    offset += piece.length
  }
  return whole
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

describe("streaming across the bridge", () => {
  let client: SwarmIdClient
  let proxy: ProxyInternals
  let store: MockChunkStore
  let bee: MockBee
  let fetchSpy: ReturnType<typeof vi.fn>
  /** Set to make the gateway hold every chunk until the signal aborts. */
  let gatewayHangs: boolean
  /** Hands a message to the proxy as if the parent posted it. */
  let sendToProxy: (data: unknown) => Promise<void>

  beforeEach(async () => {
    vi.restoreAllMocks()
    gatewayHangs = false
    store = new MockChunkStore()
    bee = new MockBee(store)

    fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      if (gatewayHangs) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          )
        })
      }
      const body = init.body as Uint8Array
      const reference = Binary.uint8ArrayToHex(
        calculateChunkAddress(body).toUint8Array(),
      )
      await store.put(reference, body)
      return new Response(JSON.stringify({ reference }))
    })
    vi.stubGlobal("fetch", fetchSpy)

    const listeners: Record<string, unknown> = {}
    const parentWindow = {
      postMessage: (
        message: { type: string },
        options: string | StructuredSerializeOptions,
      ) => {
        // Announced to `"*"` before a client exists; nothing here needs it.
        if (typeof options === "string") return
        const data = structuredClone(message, options)
        queueMicrotask(() =>
          (client as unknown as ClientInternals).handleIframeMessage(
            IframeToParentMessageSchema.parse(data),
          ),
        )
      },
    }
    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, listener: unknown) => {
        listeners[type] = listener
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      parent: parentWindow,
      location: { origin: IFRAME_ORIGIN, pathname: "/proxy" },
    })
    client = new SwarmIdClient({
      iframeOrigin: IFRAME_ORIGIN,
      metadata: { name: "Test App" },
      timeout: GENEROUS_TIMEOUT_MS,
    })
    const realProxy = new SwarmIdProxy()
    const toProxy = listeners["message"] as (event: unknown) => Promise<void>
    const send = (data: unknown) =>
      toProxy({ data, origin: PARENT_ORIGIN, source: parentWindow })
    sendToProxy = send

    await send({
      type: "parentIdentify",
      requestId: "r1",
      metadata: { name: "Test App" },
      subsidisedGatewayUrl: GATEWAY_URL,
    })
    proxy = realProxy as unknown as ProxyInternals
    proxy.authenticated = true
    proxy.appSecret = APP_SECRET_HEX
    Object.defineProperty(realProxy, "bee", { value: bee })

    const internals = client as unknown as ClientInternals
    internals.ready = true
    internals.iframe = {
      contentWindow: {
        postMessage: (
          message: unknown,
          _origin: string,
          transfer?: Transferable[],
        ) => void send(structuredClone(message, { transfer })),
      },
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const expectNothingLeftBehind = () => {
    const clientState = client as unknown as ClientInternals
    expect(clientState.pendingRequests.size).toBe(0)
    expect(clientState.downloadStreams.size).toBe(0)
    expect(proxy.inFlightRequests.size).toBe(0)
    expect(proxy.uploadSources.size).toBe(0)
    expect(proxy.downloadPulls.size).toBe(0)
  }

  describe("uploadData", () => {
    for (const size of [
      0,
      1,
      CHUNK_SIZE + 1,
      CHUNK_SIZE * 200,
      STREAM_PIECE_SIZE * 2 + 3,
    ]) {
      it(`gives ${size} bytes one reference through every input type`, async () => {
        const data = makeData(size)

        const fromBytes = await client.uploadData(data)
        const fromBlob = await client.uploadData(new Blob([data]))
        const fromFile = await client.uploadData(new File([data], "a.bin"))
        const fromStream = await client.uploadData(streamOf(data, 1000))
        const fromOddStream = await client.uploadData(
          streamOf(data, STREAM_PIECE_SIZE + 1),
        )

        expect(fromBlob.reference).toBe(fromBytes.reference)
        expect(fromFile.reference).toBe(fromBytes.reference)
        expect(fromStream.reference).toBe(fromBytes.reference)
        expect(fromOddStream.reference).toBe(fromBytes.reference)
        expect(fromStream.stampedChunks).toBe(fromBytes.stampedChunks)
        expectNothingLeftBehind()
      })
    }

    it("hands a stream it read to the end back unlocked, and uncancelled", async () => {
      const cancel = vi.fn()
      const data = makeData(CHUNK_SIZE * 3)
      let offset = 0
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (offset >= data.length) return controller.close()
            controller.enqueue(data.slice(offset, offset + CHUNK_SIZE))
            offset += CHUNK_SIZE
          },
          cancel,
        },
        { highWaterMark: 0 },
      )

      await client.uploadData(stream)
      await settle()

      expect(stream.locked).toBe(false)
      expect(cancel).not.toHaveBeenCalled()
    })

    it("still posts plain bytes as bytes", async () => {
      const data = makeData(32)
      const { reference } = await client.uploadData(data)
      expect(reference).toHaveLength(64)
    })

    it("reads an encrypted stream back", async () => {
      const data = makeData(CHUNK_SIZE * 70 + 1)
      const { reference } = await client.uploadData(new Blob([data]), {
        encrypt: true,
      })
      expect(reference).toHaveLength(128)
      expect(await client.downloadData(reference)).toEqual(data)
    })

    it("reports progress for a Blob, with a total from the start", async () => {
      const data = makeData(CHUNK_SIZE * 5)
      const progress: Array<{ total: number; processed: number }> = []
      await client.uploadData(new Blob([data]), {
        onProgress: (p) => progress.push(p),
      })
      await settle()
      expect(progress[0].total).toBeGreaterThanOrEqual(6)
      expect(progress.at(-1)).toEqual({ total: 6, processed: 6 })
    })

    describe("progress", () => {
      /** 200 leaves, the two intermediates over them, and the root. */
      const LEAVES = 200
      const CHUNKS = LEAVES + 2 + 1

      afterEach(() => {
        vi.useRealTimers()
      })

      it("posts one report an interval at most, and always the last one", async () => {
        vi.useFakeTimers({ toFake: ["Date"] })
        const progress: Array<{ total: number; processed: number }> = []

        await client.uploadData(new Blob([makeData(CHUNK_SIZE * LEAVES)]), {
          onProgress: (p) => progress.push(p),
        })

        expect(progress.length).toBeLessThanOrEqual(2)
        expect(progress.at(-1)).toEqual({ total: CHUNKS, processed: CHUNKS })
      })

      it("posts the last report of a stream of unknown length too", async () => {
        vi.useFakeTimers({ toFake: ["Date"] })
        const progress: Array<{ total: number; processed: number }> = []

        await client.uploadData(
          streamOf(makeData(CHUNK_SIZE * LEAVES), CHUNK_SIZE),
          { onProgress: (p) => progress.push(p) },
        )

        expect(progress.length).toBeLessThanOrEqual(2)
        expect(progress.at(-1)).toEqual({ total: CHUNKS, processed: CHUNKS })
      })

      it("posts a report every interval while the upload goes on", async () => {
        vi.useFakeTimers({ toFake: ["Date"] })
        const progress: Array<{ total: number; processed: number }> = []
        let offset = 0
        const data = makeData(CHUNK_SIZE * LEAVES)
        // Each chunk takes a whole interval to arrive.
        const slowStream = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (offset >= data.length) return controller.close()
              vi.setSystemTime(Date.now() + PROGRESS_INTERVAL_MS)
              controller.enqueue(data.slice(offset, offset + CHUNK_SIZE))
              offset += CHUNK_SIZE
            },
          },
          { highWaterMark: 0 },
        )

        await client.uploadData(slowStream, {
          onProgress: (p) => progress.push(p),
        })

        expect(progress.length).toBeGreaterThanOrEqual(LEAVES)
        expect(progress.at(-1)).toEqual({ total: CHUNKS, processed: CHUNKS })
      })
    })

    it("holds only a bounded part of a stream while the node is stuck", async () => {
      gatewayHangs = true
      const controller = new AbortController()
      let produced = 0
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(c) {
            produced += STREAM_PIECE_SIZE
            c.enqueue(new Uint8Array(STREAM_PIECE_SIZE))
          },
        },
        { highWaterMark: 0 },
      )

      const upload = client.uploadData(stream, undefined, {
        signal: controller.signal,
      })
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
      await settle()

      expect(produced).toBeLessThanOrEqual(STREAM_PIECE_SIZE * 2)
      controller.abort()
      await expect(upload).rejects.toMatchObject({ code: "aborted" })
    })

    it("stops when aborted, cancels the stream and forgets the request", async () => {
      gatewayHangs = true
      const controller = new AbortController()
      const cancel = vi.fn()
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(c) {
            c.enqueue(new Uint8Array(STREAM_PIECE_SIZE))
          },
          cancel,
        },
        { highWaterMark: 0 },
      )

      const upload = client.uploadData(stream, undefined, {
        signal: controller.signal,
      })
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
      const reason = new Error("user cancelled")
      controller.abort(reason)

      await expect(upload).rejects.toMatchObject({ code: "aborted" })
      await settle()
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expectNothingLeftBehind()
    })

    it("stops when aborted while the source has nothing to give", async () => {
      const controller = new AbortController()
      const stream = new ReadableStream<Uint8Array>(
        { pull: () => new Promise(() => {}) },
        { highWaterMark: 0 },
      )

      const upload = client.uploadData(stream, undefined, {
        signal: controller.signal,
      })
      await settle()
      controller.abort()

      await expect(upload).rejects.toMatchObject({ code: "aborted" })
      await settle()
      expectNothingLeftBehind()
    })

    describe("a source that goes silent", () => {
      const silentStream = (cancel: () => void) =>
        new ReadableStream<Uint8Array>(
          { pull: () => new Promise(() => {}), cancel },
          { highWaterMark: 0 },
        )

      afterEach(() => {
        vi.useRealTimers()
      })

      it("makes the proxy give up and free the drive", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
        const cancel = vi.fn()
        const upload = client.uploadData(silentStream(cancel))
        const settled = upload.catch((e: unknown) => e)

        await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)

        expect(await settled).toMatchObject({ code: "timeout" })
        await vi.advanceTimersByTimeAsync(SETTLE_MS)
        expect(cancel).toHaveBeenCalledTimes(1)
        expectNothingLeftBehind()
      })

      it("is waited for as long as a longer timeout asks", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
        const longer = STREAM_IDLE_TIMEOUT_MS * 2
        const upload = client.uploadData(silentStream(vi.fn()), undefined, {
          timeout: longer,
        })
        const settled = vi.fn()
        upload.then(settled, settled)

        await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)
        expect(settled).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(longer)
        expect(settled).toHaveBeenCalledWith(
          expect.objectContaining({ code: "timeout" }),
        )
      })

      it("is let go of at once when a chunk fails", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
        fetchSpy.mockImplementation(
          async () => new Response("no", { status: 402 }),
        )
        let delivered = false
        const stream = new ReadableStream<Uint8Array>(
          {
            pull(c) {
              if (delivered) return new Promise<void>(() => {})
              delivered = true
              c.enqueue(makeData(CHUNK_SIZE))
              return undefined
            },
          },
          { highWaterMark: 0 },
        )

        await expect(
          client.uploadData(stream, undefined, {
            timeout: STREAM_IDLE_TIMEOUT_MS * 2,
          }),
        ).rejects.toMatchObject({ code: "bee-rejected" })
        await vi.advanceTimersByTimeAsync(SETTLE_MS)

        // The proxy's deadline for the outstanding pull is the timer left.
        expect(vi.getTimerCount()).toBe(0)
        expectNothingLeftBehind()
      })
    })

    describe("a piece the proxy did not ask for", () => {
      it("is dropped while no pull is outstanding", async () => {
        gatewayHangs = true
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const controller = new AbortController()
        const stream = new ReadableStream<Uint8Array>(
          {
            pull(c) {
              c.enqueue(makeData(STREAM_PIECE_SIZE))
            },
          },
          { highWaterMark: 0 },
        )
        const upload = client
          .uploadData(stream, undefined, { signal: controller.signal })
          .catch((e: unknown) => e)
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
        await settle()
        const [requestId] = proxy.uploadSources.keys()
        const { inbox: source } = proxy.uploadSources.get(requestId) as {
          inbox: { waiting: boolean; queue: unknown[] }
        }
        expect(source.waiting).toBe(false)

        await sendToProxy({
          type: "uploadSourcePiece",
          requestId,
          data: makeData(STREAM_PIECE_SIZE),
        })

        expect(source.queue).toHaveLength(0)
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("not asked for"),
          requestId,
        )
        controller.abort()
        expect(await upload).toMatchObject({ code: "aborted" })
      })

      it("fails the upload when larger than a piece may be", async () => {
        ;(client as unknown as ClientInternals).iframe = {
          contentWindow: {
            postMessage: (
              message: unknown,
              _origin: string,
              transfer?: Transferable[],
            ) => {
              const cloned = structuredClone(message, { transfer }) as {
                type: string
                data?: Uint8Array
              }
              if (cloned.type === "uploadSourcePiece" && cloned.data) {
                cloned.data = makeData(STREAM_PIECE_SIZE + 1)
              }
              void sendToProxy(cloned)
            },
          },
        }

        const error = await client
          .uploadData(streamOf(makeData(CHUNK_SIZE), CHUNK_SIZE))
          .catch((e: unknown) => e)

        expect(error).toMatchObject({
          code: "invalid-request",
          message: expect.stringContaining(String(STREAM_PIECE_SIZE)),
        })
        await settle()
        expectNothingLeftBehind()
      })
    })

    it("fails the call when the source breaks, and stops the proxy", async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("disk went away")
        },
      })

      const error = await client.uploadData(stream).catch((e: unknown) => e)

      expect(error).toMatchObject({
        code: "invalid-request",
        message: expect.stringContaining("disk went away"),
      })
      await settle()
      expectNothingLeftBehind()
    })

    it("answers a failed chunk while the source is silent", async () => {
      fetchSpy.mockImplementation(
        async () => new Response("no", { status: 402 }),
      )
      const data = makeData(CHUNK_SIZE)
      let delivered = false
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(c) {
            if (delivered) return new Promise<void>(() => {})
            delivered = true
            c.enqueue(data)
            return undefined
          },
        },
        { highWaterMark: 0 },
      )

      await expect(client.uploadData(stream)).rejects.toMatchObject({
        code: "bee-rejected",
      })
    })
  })

  describe("a write queued behind a streaming upload to the same drive", () => {
    const BATCH_ID = "cd".repeat(32)
    const SIGNER_KEY = "ef".repeat(32)
    const QUEUED_TIMEOUT_MS = 10_000
    const HELD_MS = STREAM_IDLE_TIMEOUT_MS / 2

    /** A stream that gives one chunk, then holds the drive until released. */
    const holdingStream = () => {
      let release: () => void = () => {}
      const released = new Promise<void>((resolve) => (release = resolve))
      let gaveAChunk = false
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (!gaveAChunk) {
              gaveAChunk = true
              controller.enqueue(makeData(CHUNK_SIZE))
              return
            }
            await released
            controller.close()
          },
        },
        { highWaterMark: 0 },
      )
      return { stream, release }
    }

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
            () => op({ mode: "subsidised", gatewayUrl: GATEWAY_URL }),
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

    afterEach(() => {
      vi.useRealTimers()
    })

    it("waits its turn past its own timeout, and lands after it", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      })
      const holder = holdingStream()
      const finished: string[] = []
      const first = client.uploadData(holder.stream).then((result) => {
        finished.push("stream")
        return result
      })
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      const second = client
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

      holder.release()
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      await Promise.all([first, second])
      expect(finished).toEqual(["stream", "queued"])
      // The heartbeat stopped with the wait.
      expect(vi.getTimerCount()).toBe(0)
      expectNothingLeftBehind()
    })

    it("leaves the queue at once when aborted, and spends nothing", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      })
      const holder = holdingStream()
      const first = client.uploadData(holder.stream)
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
      const controller = new AbortController()
      const second = client.uploadData(makeData(CHUNK_SIZE), undefined, {
        signal: controller.signal,
      })
      await vi.advanceTimersByTimeAsync(SETTLE_MS)

      controller.abort()
      await expect(second).rejects.toMatchObject({ code: "aborted" })
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      expect(proxy.inFlightRequests.size).toBe(1)

      holder.release()
      await first
      // The stream's leaf only: the aborted write sent no chunk of its own.
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      expectNothingLeftBehind()
    })
  })

  /**
   * Record what the client posts to the proxy, still delivering it: each
   * message's type, and how many bytes of content it carries.
   */
  const recordPosted = () => {
    const posted: Array<{ type: string; index?: number; bytes: number }> = []
    ;(client as unknown as ClientInternals).iframe = {
      contentWindow: {
        postMessage: (
          message: {
            type: string
            index?: number
            data?: unknown
            files?: Array<{ data: unknown }>
          },
          _origin: string,
          transfer?: Transferable[],
        ) => {
          const contents = [
            message.data,
            ...(message.files ?? []).map((file) => file.data),
          ]
          const bytes = contents.reduce<number>(
            (sum, data) => sum + (data instanceof Uint8Array ? data.length : 0),
            0,
          )
          posted.push({ type: message.type, index: message.index, bytes })
          void sendToProxy(structuredClone(message, { transfer }))
        },
      },
    }
    return posted
  }

  describe("uploadFile", () => {
    const NAME = "report.pdf"
    const PLAIN = { encrypt: false }

    for (const size of [0, CHUNK_SIZE + 1, STREAM_PIECE_SIZE * 2 + 3]) {
      it(`gives ${size} bytes one reference through every input type`, async () => {
        const data = makeData(size)

        const fromBytes = await client.uploadFile(data, NAME, PLAIN)
        const fromBlob = await client.uploadFile(new Blob([data]), NAME, PLAIN)
        const fromFile = await client.uploadFile(
          new File([data], NAME),
          undefined,
          PLAIN,
        )
        const fromStream = await client.uploadFile(
          streamOf(data, 1000),
          NAME,
          PLAIN,
        )

        expect(fromBlob.reference).toBe(fromBytes.reference)
        expect(fromFile.reference).toBe(fromBytes.reference)
        expect(fromStream.reference).toBe(fromBytes.reference)
        expect(fromStream.stampedChunks).toBe(fromBytes.stampedChunks)
        expectNothingLeftBehind()
      })
    }

    it("pulls a large file in bounded pieces, never posting it whole", async () => {
      const data = makeData(STREAM_PIECE_SIZE * 3 + 1)
      const posted = recordPosted()

      await client.uploadFile(new File([data], NAME))

      const pieces = posted.filter(({ type }) => type === "uploadSourcePiece")
      expect(posted[0]).toMatchObject({ type: "uploadFile", bytes: 0 })
      expect(pieces.length).toBeGreaterThan(1)
      for (const { bytes } of posted) {
        expect(bytes).toBeLessThanOrEqual(STREAM_PIECE_SIZE)
      }
      expect(pieces.reduce((sum, { bytes }) => sum + bytes, 0)).toBe(
        data.length,
      )
    })

    it("hands a stream back unlocked once read, and cancels it on failure", async () => {
      const read = streamOf(makeData(CHUNK_SIZE), 1000)
      await client.uploadFile(read, NAME)
      expect(read.locked).toBe(false)

      fetchSpy.mockImplementation(
        async () => new Response("no", { status: 402 }),
      )
      const cancel = vi.fn()
      const failing = new ReadableStream<Uint8Array>(
        {
          pull: (controller) => controller.enqueue(makeData(CHUNK_SIZE)),
          cancel,
        },
        { highWaterMark: 0 },
      )
      await expect(client.uploadFile(failing, NAME)).rejects.toMatchObject({
        code: "bee-rejected",
      })
      await settle()
      expect(cancel).toHaveBeenCalledTimes(1)
      expectNothingLeftBehind()
    })
  })

  describe("uploadFiles", () => {
    const PLAIN = { encrypt: false }
    const FOLDER = [
      { path: "index.html", size: 11, contentType: "text/html" },
      { path: "assets/big.bin", size: STREAM_PIECE_SIZE * 2 + 3 },
      { path: "empty.txt", size: 0, contentType: "text/plain" },
      { path: "assets/small.bin", size: CHUNK_SIZE + 1 },
    ].map(({ path, size, contentType }, index) => ({
      path,
      contentType,
      data: makeData(size).map((byte) => byte ^ index),
    }))
    const asBlobs = () =>
      FOLDER.map(({ path, data, contentType }) => ({
        path,
        file: new Blob([data], { type: contentType }),
      }))

    it("gives the root an in-memory upload of the same files gives", async () => {
      const { reference: inMemory } = await uploadCollection(
        { mode: "subsidised", gatewayUrl: GATEWAY_URL },
        FOLDER,
        PLAIN,
      )

      const { reference } = await client.uploadFiles(asBlobs(), PLAIN)

      expect(reference).toBe(inMemory)
      for (const { path, data } of FOLDER) {
        expect((await client.downloadFile(reference, path)).data).toEqual(data)
      }
      expectNothingLeftBehind()
    })

    it("pulls one file at a time, in bounded pieces, each to its end before the next", async () => {
      const posted = recordPosted()

      await client.uploadFiles(asBlobs())

      expect(posted[0]).toMatchObject({ type: "uploadFiles", bytes: 0 })
      const pieces = posted.filter(({ type }) => type === "uploadSourcePiece")
      // No piece of a file comes after one of the next: a piece only ever
      // answers a pull, so no file was pulled before the one ahead ended.
      pieces.forEach(({ index }, at) => {
        expect(index).toBeGreaterThanOrEqual(pieces[at - 1]?.index ?? 0)
      })
      FOLDER.forEach(({ data }, index) => {
        const ofFile = pieces.filter((piece) => piece.index === index)
        expect(ofFile.reduce((sum, { bytes }) => sum + bytes, 0)).toBe(
          data.length,
        )
        expect(ofFile.at(-1)?.bytes).toBe(0)
        for (const { bytes } of ofFile) {
          expect(bytes).toBeLessThanOrEqual(STREAM_PIECE_SIZE)
        }
      })
      expectNothingLeftBehind()
    })

    it("counts files in its progress", async () => {
      const progress: Array<{ total: number; processed: number }> = []

      await client.uploadFiles(asBlobs(), {
        onProgress: (p) => progress.push(p),
      })

      expect(progress.at(-1)).toEqual({
        total: FOLDER.length,
        processed: FOLDER.length,
      })
    })
  })

  describe("actUploadData", () => {
    it("takes a Blob and a stream, and they read back", async () => {
      const data = makeData(CHUNK_SIZE * 3 + 1)

      for (const input of [new Blob([data]), streamOf(data, 1000)]) {
        const result = await client.actUploadData(input, [])
        expect(
          await client.actDownloadData(
            result.encryptedReference,
            result.historyReference,
            result.publisherPubKey,
          ),
        ).toEqual(data)
      }
      expectNothingLeftBehind()
    })
  })

  describe("downloadDataStream", () => {
    const upload = async (data: Uint8Array) =>
      (await client.uploadData(data)).reference

    for (const size of [
      0,
      1,
      CHUNK_SIZE,
      CHUNK_SIZE * 150 + 7,
      STREAM_PIECE_SIZE * 3 + 1,
    ]) {
      it(`reads ${size} bytes back`, async () => {
        const data = makeData(size)
        const reference = await upload(data)

        const { stream, size: reported } =
          await client.downloadDataStream(reference)

        expect(reported).toBe(size)
        expect(await readAll(stream)).toEqual(data)
        await settle()
        expectNothingLeftBehind()
      })
    }

    it("fetches nothing past the root until the stream is read", async () => {
      const reference = await upload(makeData(CHUNK_SIZE * 150))
      const download = vi.spyOn(bee.chunk, "download")

      await client.downloadDataStream(reference)
      await settle()

      expect(download).toHaveBeenCalledTimes(1)
    })

    it("delivers pieces within the limit and only when asked", async () => {
      const reference = await upload(makeData(STREAM_PIECE_SIZE * 3))
      const { stream } = await client.downloadDataStream(reference)
      const download = vi.spyOn(bee.chunk, "download")
      const reader = stream.getReader()

      const first = await reader.read()
      const fetchedForFirst = download.mock.calls.length
      await settle()

      expect(first.value?.length).toBe(STREAM_PIECE_SIZE)
      expect(download.mock.calls.length).toBe(fetchedForFirst)
      await reader.cancel()
    })

    it("rejects before any stream for a reference that is not there", async () => {
      await expect(
        client.downloadDataStream("cd".repeat(32)),
      ).rejects.toBeInstanceOf(Error)
      await settle()
      expectNothingLeftBehind()
    })

    it("stops the proxy when the reader cancels", async () => {
      const reference = await upload(makeData(STREAM_PIECE_SIZE * 3))
      const { stream } = await client.downloadDataStream(reference)
      const reader = stream.getReader()
      await reader.read()

      await reader.cancel()
      await settle()

      expectNothingLeftBehind()
    })

    it("errors the stream when the signal aborts", async () => {
      const reference = await upload(makeData(STREAM_PIECE_SIZE * 3))
      const controller = new AbortController()
      const { stream } = await client.downloadDataStream(reference, undefined, {
        signal: controller.signal,
      })
      const reader = stream.getReader()
      await reader.read()

      controller.abort()

      await expect(reader.read()).rejects.toMatchObject({ code: "aborted" })
      await settle()
      expectNothingLeftBehind()
    })

    describe("a stream nobody reads", () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      it("is ended by the proxy once no pull comes for the idle deadline", async () => {
        const reference = await upload(makeData(STREAM_PIECE_SIZE * 2))
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
        const { stream } = await client.downloadDataStream(reference)

        await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)

        expect(proxy.downloadPulls.size).toBe(0)
        expect(proxy.inFlightRequests.size).toBe(0)
        await expect(stream.getReader().read()).rejects.toMatchObject({
          code: "timeout",
        })
        expectNothingLeftBehind()
      })

      it("is waited for as long as a longer timeout asks", async () => {
        const reference = await upload(makeData(STREAM_PIECE_SIZE * 2))
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
        const longer = STREAM_IDLE_TIMEOUT_MS * 2
        const { stream } = await client.downloadDataStream(
          reference,
          undefined,
          { timeout: longer },
        )

        await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)
        expect(proxy.downloadPulls.size).toBe(1)

        await vi.advanceTimersByTimeAsync(longer)
        expect(proxy.downloadPulls.size).toBe(0)
        await expect(stream.getReader().read()).rejects.toMatchObject({
          code: "timeout",
        })
      })
    })

    it("errors the stream on a chunk that cannot be fetched", async () => {
      const reference = await upload(makeData(STREAM_PIECE_SIZE * 2))
      const { stream } = await client.downloadDataStream(reference)
      vi.spyOn(bee.chunk, "download").mockRejectedValue(new Error("gone"))

      await expect(readAll(stream)).rejects.toThrow("gone")
      await settle()
      expectNothingLeftBehind()
    })
  })

  describe("actDownloadDataStream", () => {
    it("reads ACT content back as a stream", async () => {
      const data = makeData(CHUNK_SIZE * 3 + 1)
      const result = await client.actUploadData(data, [])

      const { stream, size } = await client.actDownloadDataStream(
        result.encryptedReference,
        result.historyReference,
        result.publisherPubKey,
      )

      expect(size).toBe(data.length)
      expect(await readAll(stream)).toEqual(data)
      await settle()
      expectNothingLeftBehind()
    })
  })
})

describe("the wait for a streaming upload", () => {
  const REPLY = {
    type: "uploadDataResponse",
    reference: "ab".repeat(32),
  }
  const SHORT_MS = 30

  let client: SwarmIdClient
  let postMessage: ReturnType<typeof vi.fn>

  const deliver = (message: unknown) =>
    (client as unknown as ClientInternals).handleIframeMessage(
      message as IframeToParentMessage,
    )
  const posted = () => postMessage.mock.calls.map(([message]) => message)
  const requestIdOf = () => posted()[0].requestId as string

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      parent: { postMessage: vi.fn() },
      location: { origin: "https://localhost" },
    })
    postMessage = vi.fn()
    client = new SwarmIdClient({
      iframeOrigin: IFRAME_ORIGIN,
      metadata: { name: "Test App" },
    })
    const internals = client as unknown as ClientInternals
    internals.ready = true
    internals.iframe = { contentWindow: { postMessage } }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("restarts with every chunk the proxy reports", async () => {
    const upload = client.uploadData(new Blob([makeData(8)]), undefined, {
      timeout: SHORT_MS,
    })
    const requestId = requestIdOf()

    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, SHORT_MS * 0.6))
      deliver({ type: "uploadProgress", requestId, total: 5, processed: i })
    }
    deliver({ ...REPLY, requestId })

    await expect(upload).resolves.toMatchObject({
      reference: REPLY.reference,
    })
  })

  it("does not charge the proxy for a source that takes its time", async () => {
    let release: () => void = () => {}
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          await new Promise<void>((resolve) => (release = resolve))
          controller.enqueue(makeData(8))
        },
      },
      { highWaterMark: 0 },
    )
    const upload = client.uploadData(stream, undefined, { timeout: SHORT_MS })
    const requestId = requestIdOf()

    deliver({ type: "uploadSourcePull", requestId })
    await new Promise((resolve) => setTimeout(resolve, SHORT_MS * 3))
    release()
    await vi.waitFor(
      () =>
        expect(posted().at(-1)).toMatchObject({ type: "uploadSourcePiece" }),
      { interval: 1 },
    )
    deliver({ ...REPLY, requestId })

    await expect(upload).resolves.toMatchObject({
      reference: REPLY.reference,
    })
  })

  it("rejects with timeout after the proxy goes silent, stops it, and cancels the source", async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => controller.enqueue(makeData(8)),
        cancel,
      },
      { highWaterMark: 0 },
    )
    const upload = client.uploadData(stream, undefined, { timeout: SHORT_MS })
    const requestId = requestIdOf()

    await expect(upload).rejects.toMatchObject({ code: "timeout" })
    expect(posted().at(-1)).toEqual({ type: "abortRequest", requestId })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it("outlasts the client's default wait, which is for one round trip", async () => {
    vi.useFakeTimers()
    const CLIENT_DEFAULT_MS = 30_000
    const upload = client.uploadData(new Blob([makeData(8)]))
    const settled = vi.fn()
    upload.then(settled, settled)

    await vi.advanceTimersByTimeAsync(CLIENT_DEFAULT_MS + 1)
    expect(settled).not.toHaveBeenCalled()

    deliver({ ...REPLY, requestId: requestIdOf() })
    await expect(upload).resolves.toBeDefined()
  })

  it("rejects a download's read the proxy leaves unanswered, and stops it", async () => {
    const download = client.downloadDataStream("ab".repeat(32), undefined, {
      timeout: SHORT_MS,
    })
    const requestId = requestIdOf()
    deliver({ type: "downloadDataStreamResponse", requestId, size: 8 })
    const { stream } = await download

    await expect(stream.getReader().read()).rejects.toMatchObject({
      code: "timeout",
    })
    expect(posted().map(({ type }) => type)).toEqual([
      "downloadDataStream",
      "downloadStreamPull",
      "abortRequest",
    ])
  })

  it("keeps the round-trip bound for plain bytes, and stops the proxy at it", async () => {
    await expect(
      client.uploadData(makeData(8), undefined, { timeout: SHORT_MS }),
    ).rejects.toMatchObject({ code: "timeout" })
    expect(posted().map(({ type }) => type)).toEqual([
      "uploadData",
      "abortRequest",
    ])
  })
})

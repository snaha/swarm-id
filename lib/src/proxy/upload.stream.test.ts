// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `uploadDataStream`: the bytes arrive piece by piece and only as fast as the
 * upload can take them. The reference must not depend on how they were cut
 * up, and a large source must never be held whole.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { SwarmIdError } from "../errors"
import { downloadDataWithChunkAPI } from "./download-data"
import {
  uploadData,
  uploadDataStream,
  type ChunkCounter,
  type UploadTarget,
} from "./upload"
import {
  CHUNK_SIZE,
  ENCRYPTED_REFS_PER_CHUNK,
  PLAIN_REFS_PER_CHUNK,
} from "./chunking"
import {
  MockBee,
  MockChunkStore,
  createMockStamper,
} from "./feeds/epochs/test-utils"
import type { UploadProgress } from "./types"

const GATEWAY = "https://gateway.example"
const REFERENCE = "ab".repeat(32)
const CONCURRENCY = 4
const PIECE_SIZE = 64 * 1024

/** Every shape the Merkle tree can take at the boundaries that matter. */
const SIZES = [
  0,
  1,
  CHUNK_SIZE - 1,
  CHUNK_SIZE,
  CHUNK_SIZE + 1,
  CHUNK_SIZE * 3 + 1,
  CHUNK_SIZE * ENCRYPTED_REFS_PER_CHUNK,
  CHUNK_SIZE * (ENCRYPTED_REFS_PER_CHUNK + 1),
  CHUNK_SIZE * PLAIN_REFS_PER_CHUNK,
  CHUNK_SIZE * (PLAIN_REFS_PER_CHUNK + 1),
  CHUNK_SIZE * (PLAIN_REFS_PER_CHUNK + 2) + 17,
  CHUNK_SIZE * (PLAIN_REFS_PER_CHUNK * 2 + 1),
]

/** Bytes that differ chunk by chunk, so no two leaves share an address. */
function makeData(length: number): Uint8Array {
  const data = new Uint8Array(length)
  for (let i = 0; i < length; i++) data[i] = (i * 31 + (i >> 12)) & 0xff
  return data
}

async function* piecesOf(
  data: Uint8Array,
  pieceSize: number,
): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += pieceSize) {
    yield data.slice(i, i + pieceSize)
  }
}

/** Stamper target whose node records what it was sent. */
function stamperSetup(): {
  bee: MockBee
  target: UploadTarget
  uploaded: () => string[]
} {
  const store = new MockChunkStore()
  const bee = new MockBee(store)
  const uploaded: string[] = []
  const original = bee.chunk.upload
  bee.chunk.upload = async (stamp, data, options, requestOptions) => {
    const result = await original(stamp, data, options, requestOptions)
    uploaded.push(result.reference.toHex())
    return result
  }
  return {
    bee,
    target: { mode: "stamper", bee, stamper: createMockStamper() },
    uploaded: () => uploaded,
  }
}

/** A node that takes each chunk only when the test says so. */
function heldBack(bee: MockBee): {
  started: () => number
  release: () => void
  fail: (error: Error) => void
} {
  type Waiter = { resolve: () => void; reject: (error: Error) => void }
  const waiters: Waiter[] = []
  const original = bee.chunk.upload
  let started = 0
  let released = false
  bee.chunk.upload = async (stamp, data, options, requestOptions) => {
    started++
    if (!released) {
      await new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject })
        requestOptions?.signal?.addEventListener("abort", () =>
          reject(new Error("Request aborted")),
        )
      })
    }
    return original(stamp, data, options, requestOptions)
  }
  return {
    started: () => started,
    release: () => {
      released = true
      for (const waiter of waiters.splice(0)) waiter.resolve()
    },
    fail: (error) => {
      released = true
      for (const waiter of waiters.splice(0)) waiter.reject(error)
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("uploadDataStream", () => {
  describe("gives the reference uploadData gives", () => {
    for (const size of SIZES) {
      it(`for ${size} bytes, however they are cut up`, async () => {
        const data = makeData(size)
        const buffered = stamperSetup()
        const { reference } = await uploadData(buffered.target, data)

        for (const pieceSize of [1, CHUNK_SIZE - 1, CHUNK_SIZE, PIECE_SIZE]) {
          // Slicing by one byte is the slow case; the small sizes prove it.
          if (pieceSize === 1 && size > CHUNK_SIZE * 2) continue
          const streamed = stamperSetup()
          const result = await uploadDataStream(
            streamed.target,
            piecesOf(data, pieceSize),
          )
          expect(result.reference).toBe(reference)
          expect([...streamed.uploaded()].sort()).toEqual(
            [...buffered.uploaded()].sort(),
          )
        }
      })
    }

    it("on a subsidised gateway too", async () => {
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ reference: REFERENCE })),
      )
      vi.stubGlobal("fetch", fetchMock)
      const target: UploadTarget = { mode: "subsidised", gatewayUrl: GATEWAY }
      const data = makeData(CHUNK_SIZE * 3 + 1)

      const buffered = await uploadData(target, data)
      const sent = fetchMock.mock.calls.length
      fetchMock.mockClear()
      const streamed = await uploadDataStream(
        target,
        piecesOf(data, PIECE_SIZE),
      )

      expect(streamed.reference).toBe(buffered.reference)
      expect(fetchMock.mock.calls.length).toBe(sent)
    })
  })

  it("treats a source of nothing as Bee's empty file", async () => {
    const buffered = stamperSetup()
    const { reference } = await uploadData(buffered.target, new Uint8Array(0))

    const streamed = stamperSetup()
    const result = await uploadDataStream(
      streamed.target,
      piecesOf(new Uint8Array(0), PIECE_SIZE),
    )

    expect(result.reference).toBe(reference)
  })

  it("skips empty pieces", async () => {
    const data = makeData(CHUNK_SIZE + 1)
    const buffered = stamperSetup()
    const { reference } = await uploadData(buffered.target, data)

    async function* withGaps(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(0)
      yield data.slice(0, 10)
      yield new Uint8Array(0)
      yield data.slice(10)
      yield new Uint8Array(0)
    }
    const streamed = stamperSetup()

    expect(
      (await uploadDataStream(streamed.target, withGaps())).reference,
    ).toBe(reference)
  })

  it("reads an encrypted upload back byte for byte", async () => {
    const { bee, target } = stamperSetup()
    const data = makeData(CHUNK_SIZE * (ENCRYPTED_REFS_PER_CHUNK * 2 + 2) + 5)

    const { reference } = await uploadDataStream(
      target,
      piecesOf(data, PIECE_SIZE),
      { encryptionKey: true },
    )

    expect(reference).toHaveLength(128)
    expect(await downloadDataWithChunkAPI(bee, reference)).toEqual(data)
  })

  it("counts every chunk it sends", async () => {
    const { target, uploaded } = stamperSetup()
    const counter: ChunkCounter = { chunks: 0 }
    await uploadDataStream(
      { ...target, counter },
      piecesOf(makeData(CHUNK_SIZE * 3 + 1), PIECE_SIZE),
    )
    expect(counter.chunks).toBe(uploaded().length)
  })

  describe("memory", () => {
    /** One piece being cut up, the window in flight, the chunk at hand. */
    const boundFor = (window: number) => PIECE_SIZE + (window + 1) * CHUNK_SIZE

    it("stops reading the source while the node holds every chunk back", async () => {
      const { bee, target } = stamperSetup()
      const node = heldBack(bee)
      let pulled = 0
      const size = CHUNK_SIZE * 2_000
      async function* source(): AsyncGenerator<Uint8Array> {
        for await (const piece of piecesOf(makeData(size), PIECE_SIZE)) {
          pulled += piece.length
          yield piece
        }
      }

      const upload = uploadDataStream(target, source(), {
        encryptionKey: true,
        httpConcurrency: CONCURRENCY,
      })
      await vi.waitFor(() => expect(node.started()).toBe(CONCURRENCY))
      // Long enough for a source nothing holds back to run to its end.
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(node.started()).toBe(CONCURRENCY)
      expect(pulled).toBeLessThanOrEqual(boundFor(CONCURRENCY))

      node.release()
      await upload
      expect(pulled).toBe(size)
    })

    it("never has more of a large source in hand than the window", async () => {
      const { bee, target } = stamperSetup()
      const size = CHUNK_SIZE * 3_000
      let pulled = 0
      let acked = 0
      let highWater = 0

      const original = bee.chunk.upload
      bee.chunk.upload = async (stamp, data, options, requestOptions) => {
        highWater = Math.max(highWater, pulled - acked)
        const result = await original(stamp, data, options, requestOptions)
        // A leaf carries its span: 8 bytes that were never in the source.
        const SPAN_BYTES = 8
        acked += (data as Uint8Array).length - SPAN_BYTES
        return result
      }
      async function* source(): AsyncGenerator<Uint8Array> {
        for await (const piece of piecesOf(makeData(size), PIECE_SIZE)) {
          pulled += piece.length
          yield piece
        }
      }

      await uploadDataStream(target, source(), {
        httpConcurrency: CONCURRENCY,
      })

      expect(pulled).toBe(size)
      expect(highWater).toBeLessThanOrEqual(boundFor(CONCURRENCY))
    })

    it("does not keep the address of every chunk", async () => {
      const { target } = stamperSetup()
      const result = await uploadDataStream(
        target,
        piecesOf(makeData(CHUNK_SIZE * 3), PIECE_SIZE),
        { encryptionKey: true },
      )
      expect(result.chunkAddresses).toBeUndefined()
    })
  })

  describe("cancellation", () => {
    it("stops at once while the source is silent, and closes it", async () => {
      const { target } = stamperSetup()
      const controller = new AbortController()
      let finished = false
      async function* stalls(): AsyncGenerator<Uint8Array> {
        try {
          yield makeData(CHUNK_SIZE)
          await new Promise<void>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () =>
              reject(new SwarmIdError("aborted", "Request aborted")),
            )
          })
        } finally {
          finished = true
        }
      }

      const upload = uploadDataStream(
        { ...target, signal: controller.signal },
        stalls(),
      )
      await new Promise((resolve) => setTimeout(resolve, 5))
      controller.abort()

      await expect(upload).rejects.toMatchObject({ code: "aborted" })
      expect(finished).toBe(true)
    })

    it("rejects with aborted without touching the node once aborted", async () => {
      const { target, uploaded } = stamperSetup()
      await expect(
        uploadDataStream(
          { ...target, signal: AbortSignal.abort() },
          piecesOf(makeData(CHUNK_SIZE), PIECE_SIZE),
        ),
      ).rejects.toMatchObject({ code: "aborted" })
      expect(uploaded()).toEqual([])
    })

    it("stops the chunks in flight and reads no more", async () => {
      const { bee, target } = stamperSetup()
      const node = heldBack(bee)
      const controller = new AbortController()
      let pulled = 0
      async function* source(): AsyncGenerator<Uint8Array> {
        for await (const piece of piecesOf(
          makeData(CHUNK_SIZE * 2_000),
          PIECE_SIZE,
        )) {
          pulled += piece.length
          yield piece
        }
      }

      const upload = uploadDataStream(
        { ...target, signal: controller.signal },
        source(),
        { encryptionKey: true, httpConcurrency: CONCURRENCY },
      )
      await vi.waitFor(() => expect(node.started()).toBe(CONCURRENCY))
      const pulledBeforeAbort = pulled
      controller.abort()

      await expect(upload).rejects.toThrow()
      expect(pulled).toBe(pulledBeforeAbort)
      expect(node.started()).toBe(CONCURRENCY)
    })
  })

  describe("failure", () => {
    it("ends with a failed chunk even while the source is silent", async () => {
      const { bee, target } = stamperSetup()
      const node = heldBack(bee)
      async function* stallsAfterAChunk(): AsyncGenerator<Uint8Array> {
        yield makeData(CHUNK_SIZE)
        await new Promise(() => {})
      }

      const upload = uploadDataStream(target, stallsAfterAChunk(), {
        encryptionKey: true,
        httpConcurrency: CONCURRENCY,
      })
      await vi.waitFor(() => expect(node.started()).toBe(1))
      node.fail(new Error("batch is full"))

      await expect(upload).rejects.toThrow("batch is full")
    })

    it("surfaces the source's own failure", async () => {
      const { target } = stamperSetup()
      async function* breaks(): AsyncGenerator<Uint8Array> {
        yield makeData(CHUNK_SIZE)
        throw new Error("disk went away")
      }
      await expect(uploadDataStream(target, breaks())).rejects.toThrow(
        "disk went away",
      )
    })
  })

  describe("progress", () => {
    const SIZE = CHUNK_SIZE * (PLAIN_REFS_PER_CHUNK + 2)
    /** The leaves, the two intermediates over them, and the root. */
    const CHUNKS = PLAIN_REFS_PER_CHUNK + 2 + 2 + 1

    it("knows the end from the start when told the size", async () => {
      const { target } = stamperSetup()
      const progress: UploadProgress[] = []

      await uploadDataStream(target, piecesOf(makeData(SIZE), PIECE_SIZE), {
        size: SIZE,
        onProgress: (p) => progress.push(p),
      })

      expect(progress[0].total).toBeGreaterThanOrEqual(CHUNKS)
      expect(progress.at(-1)).toEqual({ total: CHUNKS, processed: CHUNKS })
    })

    it("counts what it has seen when it does not", async () => {
      const { target } = stamperSetup()
      const progress: UploadProgress[] = []

      await uploadDataStream(target, piecesOf(makeData(SIZE), PIECE_SIZE), {
        onProgress: (p) => progress.push(p),
      })

      for (const { total, processed } of progress) {
        expect(processed).toBeLessThanOrEqual(total)
      }
      expect(progress.at(-1)).toEqual({ total: CHUNKS, processed: CHUNKS })
    })
  })
})

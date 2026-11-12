// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, afterEach } from "vitest"
import { STREAM_PIECE_SIZE } from "../proxy/chunking"
import { openPieceSource, type PieceSource } from "./piece-source"

async function drain(source: PieceSource): Promise<Uint8Array[]> {
  const pieces: Uint8Array[] = []
  for (;;) {
    const piece = await source.next()
    if (!piece) return pieces
    pieces.push(piece)
  }
}

function concat(pieces: Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(pieces.reduce((sum, p) => sum + p.length, 0))
  let offset = 0
  for (const piece of pieces) {
    whole.set(piece, offset)
    offset += piece.length
  }
  return whole
}

function makeData(length: number): Uint8Array {
  const data = new Uint8Array(length)
  for (let i = 0; i < length; i++) data[i] = i & 0xff
  return data
}

function streamOf(pieces: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece)
      controller.close()
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("openPieceSource", () => {
  it("has nothing to say about plain bytes", () => {
    expect(openPieceSource(new Uint8Array(4))).toBeUndefined()
  })

  describe("a Blob", () => {
    it("reads back byte for byte, in bounded pieces, and knows its size", async () => {
      const data = makeData(STREAM_PIECE_SIZE * 2 + 5)
      const source = openPieceSource(new Blob([data]))!

      expect(source.size).toBe(data.length)
      const pieces = await drain(source)

      expect(concat(pieces)).toEqual(data)
      for (const piece of pieces) {
        expect(piece.length).toBeLessThanOrEqual(STREAM_PIECE_SIZE)
      }
    })

    // Safari's `Blob.stream()` hands a whole in-memory blob over as one piece.
    it("never goes through Blob.stream()", async () => {
      const stream = vi.spyOn(Blob.prototype, "stream")
      await drain(openPieceSource(new Blob([makeData(1024)]))!)
      expect(stream).not.toHaveBeenCalled()
    })

    it("takes a File, which is a Blob", async () => {
      const data = makeData(1024)
      const source = openPieceSource(new File([data], "a.bin"))!
      expect(concat(await drain(source))).toEqual(data)
    })

    it("has no pieces when empty", async () => {
      expect(await drain(openPieceSource(new Blob([]))!)).toEqual([])
    })
  })

  describe("a ReadableStream", () => {
    it("cuts an oversized piece down and reads the rest later", async () => {
      const data = makeData(STREAM_PIECE_SIZE * 3 + 1)
      const source = openPieceSource(streamOf([data]))!

      expect(source.size).toBeUndefined()
      const pieces = await drain(source)

      expect(concat(pieces)).toEqual(data)
      for (const piece of pieces) {
        expect(piece.length).toBeLessThanOrEqual(STREAM_PIECE_SIZE)
      }
    })

    // A posted view clones its whole underlying buffer, so a small piece of a
    // large one would carry all of it across, and transferring it would detach
    // bytes the caller may still hold.
    it("hands out pieces that own their buffer", async () => {
      const shared = makeData(STREAM_PIECE_SIZE * 2)
      const source = openPieceSource(streamOf([shared.subarray(0, 16)]))!

      const piece = (await source.next())!

      expect(piece.buffer.byteLength).toBe(16)
      expect(piece.buffer).not.toBe(shared.buffer)
    })

    it("skips empty pieces rather than ending early", async () => {
      const source = openPieceSource(
        streamOf([new Uint8Array(0), makeData(3), new Uint8Array(0)]),
      )!
      expect(concat(await drain(source))).toEqual(makeData(3))
    })

    it("refuses a chunk that is not bytes", async () => {
      const source = openPieceSource(
        streamOf(["text" as unknown as Uint8Array]),
      )!
      await expect(source.next()).rejects.toMatchObject({
        code: "invalid-request",
      })
    })

    it("refuses a stream someone else is reading", () => {
      const stream = streamOf([makeData(3)])
      stream.getReader()
      expect(() => openPieceSource(stream)).toThrowError(
        expect.objectContaining({ code: "invalid-request" }),
      )
    })

    it("does not read ahead", async () => {
      let pulled = 0
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled++
            controller.enqueue(makeData(8))
          },
        },
        { highWaterMark: 0 },
      )
      const source = openPieceSource(stream)!

      expect(pulled).toBe(0)
      await source.next()
      expect(pulled).toBe(1)
    })

    it("cancels the stream, passing the reason on", async () => {
      const cancel = vi.fn()
      const source = openPieceSource(
        new ReadableStream<Uint8Array>({ cancel }),
      )!
      const reason = new Error("stopped")

      await source.cancel(reason)

      expect(cancel).toHaveBeenCalledWith(reason)
    })
  })
})

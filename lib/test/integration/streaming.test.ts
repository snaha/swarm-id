// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The streaming upload and download paths against a real node: what Bee stores
 * from a stream must be what it serves through its own `/bytes` API, and a
 * stream read back must be the bytes that went in.
 */

import { describe, it, expect, beforeAll, inject } from "vitest"
import type { Bee } from "@ethersphere/bee-js"
import {
  uploadData,
  uploadDataStream,
  type UploadTarget,
} from "../../src/proxy/upload"
import { openDataStream } from "../../src/proxy/download-data"
import { rechunk, STREAM_PIECE_SIZE } from "../../src/proxy/chunking"
import { createClusterContext } from "./cluster"

const MAX_CHUNK = 4096
const PLAIN_FANOUT = 128
const ENCRYPTED_FANOUT = 64
/** Comfortably over the suite's default for ~130 sequential chunk uploads. */
const UPLOAD_TIMEOUT_MS = 180_000
const ODD_PIECE_SIZE = 12_345

function distinctChunkPayload(size: number): Uint8Array {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) data[i] = (i * 3 + (i >> 12)) & 0xff
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

async function readAll(pieces: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const piece of pieces) parts.push(piece)
  const whole = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let offset = 0
  for (const part of parts) {
    whole.set(part, offset)
    offset += part.length
  }
  return whole
}

describe("Streaming against a real Bee", () => {
  let bee: Bee
  let target: UploadTarget

  beforeAll(() => {
    ;({ bee, target } = createClusterContext(inject("clusterBatchId")))
  })

  it(
    "gives a stream the reference of the same bytes, served by Bee's /bytes",
    { timeout: UPLOAD_TIMEOUT_MS },
    async () => {
      const data = distinctChunkPayload((PLAIN_FANOUT + 2) * MAX_CHUNK)

      const buffered = await uploadData(target, data)
      const streamed = await uploadDataStream(
        target,
        piecesOf(data, ODD_PIECE_SIZE),
        { size: data.length },
      )

      expect(streamed.reference).toBe(buffered.reference)
      const served = (
        await bee.data.download(streamed.reference)
      ).toUint8Array()
      expect(served).toEqual(data)
    },
  )

  it(
    "reads a plain upload back through the streaming download",
    { timeout: UPLOAD_TIMEOUT_MS },
    async () => {
      const data = distinctChunkPayload((PLAIN_FANOUT + 1) * MAX_CHUNK + 17)
      const { reference } = await uploadDataStream(
        target,
        piecesOf(data, STREAM_PIECE_SIZE),
      )

      const download = await openDataStream(bee, reference)

      expect(download.size).toBe(data.length)
      expect(
        await readAll(rechunk(download.leaves, STREAM_PIECE_SIZE)),
      ).toEqual(data)
    },
  )

  it(
    "reads an encrypted stream back",
    { timeout: UPLOAD_TIMEOUT_MS },
    async () => {
      const data = distinctChunkPayload((ENCRYPTED_FANOUT + 3) * MAX_CHUNK + 1)
      const { reference } = await uploadDataStream(
        target,
        piecesOf(data, ODD_PIECE_SIZE),
        { encryptionKey: true },
      )

      expect(reference).toHaveLength(128)
      const download = await openDataStream(bee, reference)
      expect(await readAll(download.leaves)).toEqual(data)
    },
  )
})

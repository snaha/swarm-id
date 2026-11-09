// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `openDataStream` walks the tree depth-first and fetches no further ahead of
 * the reader than one batch per level, so a large file is never held whole.
 */

import { describe, it, expect, vi } from "vitest"
import { uploadData, type UploadTarget } from "./upload"
import { downloadDataWithChunkAPI, openDataStream } from "./download-data"
import {
  CHUNK_SIZE,
  ENCRYPTED_REFS_PER_CHUNK,
  PLAIN_REFS_PER_CHUNK,
} from "./chunking"
import { DEFAULT_DOWNLOAD_CONCURRENCY } from "../chunk"
import {
  MockBee,
  MockChunkStore,
  createMockStamper,
} from "./feeds/epochs/test-utils"

function makeData(length: number): Uint8Array {
  const data = new Uint8Array(length)
  for (let i = 0; i < length; i++) data[i] = (i * 31 + (i >> 12)) & 0xff
  return data
}

function setup(): { bee: MockBee; target: UploadTarget } {
  const bee = new MockBee(new MockChunkStore())
  return { bee, target: { mode: "stamper", bee, stamper: createMockStamper() } }
}

async function readAll(leaves: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const pieces: Uint8Array[] = []
  for await (const leaf of leaves) pieces.push(leaf)
  const whole = new Uint8Array(pieces.reduce((sum, p) => sum + p.length, 0))
  let offset = 0
  for (const piece of pieces) {
    whole.set(piece, offset)
    offset += piece.length
  }
  return whole
}

describe("openDataStream", () => {
  for (const size of [
    0,
    1,
    CHUNK_SIZE,
    CHUNK_SIZE + 1,
    CHUNK_SIZE * PLAIN_REFS_PER_CHUNK,
    CHUNK_SIZE * (PLAIN_REFS_PER_CHUNK + 1),
    CHUNK_SIZE * (PLAIN_REFS_PER_CHUNK * 2 + 3) + 9,
  ]) {
    it(`reads ${size} plain bytes in order`, async () => {
      const { bee, target } = setup()
      const data = makeData(size)
      const { reference } = await uploadData(target, data)

      const download = await openDataStream(bee, reference)

      expect(download.size).toBe(size)
      expect(await readAll(download.leaves)).toEqual(data)
    })
  }

  it("reads an encrypted tree in order", async () => {
    const { bee, target } = setup()
    const size = CHUNK_SIZE * (ENCRYPTED_REFS_PER_CHUNK * 2 + 3) + 9
    const data = makeData(size)
    const { reference } = await uploadData(target, data, {
      encryptionKey: true,
    })

    const download = await openDataStream(bee, reference)

    expect(download.size).toBe(size)
    expect(await readAll(download.leaves)).toEqual(data)
  })

  it("matches the buffered read", async () => {
    const { bee, target } = setup()
    const data = makeData(CHUNK_SIZE * (PLAIN_REFS_PER_CHUNK + 5))
    const { reference } = await uploadData(target, data)

    const download = await openDataStream(bee, reference)

    expect(await readAll(download.leaves)).toEqual(
      await downloadDataWithChunkAPI(bee, reference),
    )
  })

  it("fails before the first byte when the root is missing", async () => {
    const { bee } = setup()
    await expect(openDataStream(bee, "ab".repeat(32))).rejects.toThrow()
  })

  it("rejects a malformed reference", async () => {
    const { bee } = setup()
    await expect(openDataStream(bee, "abcd")).rejects.toThrow(
      "Invalid reference length",
    )
  })

  it("fetches only the root until something reads", async () => {
    const { bee, target } = setup()
    const { reference } = await uploadData(
      target,
      makeData(CHUNK_SIZE * (PLAIN_REFS_PER_CHUNK * 3)),
    )
    const download = vi.spyOn(bee.chunk, "download")

    await openDataStream(bee, reference)

    expect(download).toHaveBeenCalledTimes(1)
  })

  it("fetches one batch per level to give the first leaf", async () => {
    const { bee, target } = setup()
    const leaves = PLAIN_REFS_PER_CHUNK * PLAIN_REFS_PER_CHUNK + 1
    const { reference } = await uploadData(
      target,
      makeData(CHUNK_SIZE * Math.min(leaves, 1200)),
    )
    const download = vi.spyOn(bee.chunk, "download")

    const opened = await openDataStream(bee, reference)
    await opened.leaves.next()

    const ROOT_AND_TWO_LEVELS = 1 + DEFAULT_DOWNLOAD_CONCURRENCY * 2
    expect(download.mock.calls.length).toBeLessThanOrEqual(ROOT_AND_TWO_LEVELS)
  })

  it("stops fetching when it is aborted between batches", async () => {
    const { bee, target } = setup()
    const { reference } = await uploadData(
      target,
      makeData(CHUNK_SIZE * (PLAIN_REFS_PER_CHUNK * 2)),
    )
    const controller = new AbortController()
    const download = vi.spyOn(bee.chunk, "download")

    const opened = await openDataStream(bee, reference, {
      signal: controller.signal,
    })
    await opened.leaves.next()
    const fetched = download.mock.calls.length
    controller.abort()

    await expect(readAll(opened.leaves)).rejects.toMatchObject({
      code: "aborted",
    })
    expect(download.mock.calls.length).toBe(fetched)
  })
})

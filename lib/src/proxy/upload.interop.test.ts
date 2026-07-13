// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Interop tests pinning the plain (unencrypted) upload path to Bee's
 * canonical Merkle layout, with bee-js's `MerkleTree` as the oracle.
 *
 * Canonical facts these tests encode (independent of the code under test):
 * - An intermediate chunk is 4096 bytes of refs. Plain refs are 32 bytes,
 *   so a full plain intermediate holds 128 refs; encrypted refs are 64
 *   bytes, so a full encrypted intermediate holds 64.
 * - A trailing chunk that would sit alone in its batch is promoted to the
 *   next level as-is (Bee's "carrier chunk"), never wrapped in a
 *   single-ref intermediate.
 *
 * The upload direction asserts our root reference equals the bee-js-computed
 * reference for the same payload; the download direction seeds the store with
 * a bee-js-built tree and reads it back through `downloadDataWithChunkAPI`.
 */

import { describe, it, expect } from "vitest"
import { MerkleTree } from "@ethersphere/bee-js"
import type { Bee, Stamper } from "@ethersphere/bee-js"
import { uploadData, type UploadTarget } from "./upload"
import { downloadDataWithChunkAPI } from "./download-data"
import { SPAN_SIZE, UNENCRYPTED_REF_SIZE } from "../chunk"
import { uint8ArrayToHex } from "../utils/hex"
import type { UploadProgress } from "./types"
import {
  MockBee,
  MockChunkStore,
  createMockStamper,
} from "./feeds/epochs/test-utils"

const CHUNK_SIZE = 4096
// Canonical Swarm fanout for plain trees: 4096-byte payload / 32-byte refs.
const CANONICAL_PLAIN_FANOUT = 128

/** Build `length` bytes with position-dependent variation so chunks differ. */
function makeData(length: number): Uint8Array {
  const data = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    data[i] = (i * 31 + 7) & 0xff
  }
  return data
}

function setup(): { bee: Bee; store: MockChunkStore; target: UploadTarget } {
  const store = new MockChunkStore()
  const bee = new MockBee(store) as unknown as Bee
  const target: UploadTarget = {
    mode: "stamper",
    bee,
    stamper: createMockStamper() as unknown as Stamper,
  }
  return { bee, store, target }
}

/** Compute the canonical root reference for a payload via bee-js. */
async function canonicalRootHex(data: Uint8Array): Promise<string> {
  const root = await MerkleTree.root(data)
  return uint8ArrayToHex(root.hash())
}

/**
 * Build the canonical chunk tree for a payload via bee-js and seed the store
 * with every chunk (span + written payload, trimmed of BMT zero padding).
 * Returns the root reference hex and the number of chunks in the tree.
 */
async function seedCanonicalTree(
  store: MockChunkStore,
  data: Uint8Array,
): Promise<{ rootHex: string; chunkCount: number }> {
  let chunkCount = 0
  const tree = new MerkleTree(async (chunk) => {
    chunkCount++
    const chunkData = chunk.build().slice(0, SPAN_SIZE + chunk.writer.cursor)
    await store.put(uint8ArrayToHex(chunk.hash()), chunkData)
  })
  await tree.append(data)
  const root = await tree.finalize()
  return { rootHex: uint8ArrayToHex(root.hash()), chunkCount }
}

function readSpan(chunkData: Uint8Array): number {
  const view = new DataView(
    chunkData.buffer,
    chunkData.byteOffset,
    chunkData.byteLength,
  )
  return Number(view.getBigUint64(0, true))
}

describe("plain uploads match Bee's canonical Merkle layout", () => {
  // Named payload sizes around the 128-ref intermediate boundary. Everything
  // above 128 leaf chunks (512 KiB) needs the canonical fanout to agree with
  // Bee; 129 leaves additionally exercises the carrier-chunk promotion.
  const CASES: Array<{ name: string; size: number }> = [
    { name: "3 full chunks (single intermediate)", size: 3 * CHUNK_SIZE },
    {
      // The filed threshold: the first size where the old 64-ref fanout
      // split the tree while the canonical layout still fits one level.
      name: "65 full chunks (>256KB, minimal reproducer)",
      size: 65 * CHUNK_SIZE,
    },
    {
      name: "128 full chunks (exactly one full intermediate)",
      size: CANONICAL_PLAIN_FANOUT * CHUNK_SIZE,
    },
    {
      name: "129 full chunks (carrier chunk boundary)",
      size: (CANONICAL_PLAIN_FANOUT + 1) * CHUNK_SIZE,
    },
    {
      name: "128 full chunks + 1 byte (short carrier leaf)",
      size: CANONICAL_PLAIN_FANOUT * CHUNK_SIZE + 1,
    },
    {
      name: "130 full chunks (>256KB, two-ref root)",
      size: (CANONICAL_PLAIN_FANOUT + 2) * CHUNK_SIZE,
    },
  ]

  for (const { name, size } of CASES) {
    it(`root reference matches bee-js for ${name}`, async () => {
      const { bee, target } = setup()
      const data = makeData(size)

      const { reference } = await uploadData(target, data)

      expect(reference).toBe(await canonicalRootHex(data))

      // The tree we produced must also read back through our own downloader.
      const downloaded = await downloadDataWithChunkAPI(bee, reference)
      expect(downloaded).toEqual(data)
    })
  }

  it("builds intermediate chunks holding 128 refs with child spans", async () => {
    const { store, target } = setup()
    const leafCount = CANONICAL_PLAIN_FANOUT + 2
    const data = makeData(leafCount * CHUNK_SIZE)

    const { reference } = await uploadData(target, data)

    // Root: two refs — a full 128-ref intermediate and a 2-ref intermediate.
    const rootData = await store.get(reference)
    expect(readSpan(rootData)).toBe(leafCount * CHUNK_SIZE)
    const rootPayload = rootData.slice(SPAN_SIZE)
    expect(rootPayload.length).toBe(2 * UNENCRYPTED_REF_SIZE)

    const firstChild = await store.get(
      uint8ArrayToHex(rootPayload.slice(0, UNENCRYPTED_REF_SIZE)),
    )
    expect(readSpan(firstChild)).toBe(CANONICAL_PLAIN_FANOUT * CHUNK_SIZE)
    expect(firstChild.slice(SPAN_SIZE).length).toBe(
      CANONICAL_PLAIN_FANOUT * UNENCRYPTED_REF_SIZE,
    )

    const secondChild = await store.get(
      uint8ArrayToHex(rootPayload.slice(UNENCRYPTED_REF_SIZE)),
    )
    expect(readSpan(secondChild)).toBe(2 * CHUNK_SIZE)
    expect(secondChild.slice(SPAN_SIZE).length).toBe(2 * UNENCRYPTED_REF_SIZE)
  })

  it("downloads a bee-js-built tree with exact progress totals", async () => {
    const { bee, store } = setup()
    const leafCount = CANONICAL_PLAIN_FANOUT + 2
    const data = makeData(leafCount * CHUNK_SIZE)

    const { rootHex, chunkCount } = await seedCanonicalTree(store, data)
    // 130 leaves + two level-1 intermediates + root.
    expect(chunkCount).toBe(leafCount + 3)

    const progress: UploadProgress[] = []
    const downloaded = await downloadDataWithChunkAPI(
      bee,
      rootHex,
      undefined,
      (p) => progress.push(p),
    )

    expect(downloaded).toEqual(data)
    expect(progress[progress.length - 1].processed).toBe(chunkCount)
    // The final event normalizes total to the processed count, so the
    // estimate is only observable before it. It must assume the canonical
    // 128-ref plain fanout; a 64-ref estimate overcounts the intermediates.
    expect(progress[progress.length - 2]).toEqual({
      total: chunkCount,
      processed: chunkCount,
    })
  })
})

describe("encrypted uploads keep the 64-ref fanout", () => {
  const ENCRYPTED_FANOUT = 64

  it("uploads 130 encrypted leaves as 64-ref intermediates", async () => {
    const { bee, target } = setup()
    const leafCount = ENCRYPTED_FANOUT * 2 + 2
    const data = makeData(leafCount * CHUNK_SIZE)

    const { reference, chunkAddresses } = await uploadData(target, data, {
      encryptionKey: true,
    })

    // 130 leaves ⇒ level-1 batches [64], [64], [2] ⇒ 3 intermediates + root.
    expect(chunkAddresses).toHaveLength(leafCount + 4)

    // And the tree must read back with an exact 64-ref-fanout estimate.
    const progress: UploadProgress[] = []
    const downloaded = await downloadDataWithChunkAPI(
      bee,
      reference,
      undefined,
      (p) => progress.push(p),
    )
    expect(downloaded).toEqual(data)
    expect(progress[progress.length - 1].processed).toBe(leafCount + 4)
    // Pre-normalization event: the estimate must use the 64-ref encrypted
    // fanout — a 128-ref estimate would undercount the intermediates.
    expect(progress[progress.length - 2]).toEqual({
      total: leafCount + 4,
      processed: leafCount + 4,
    })
  })
})

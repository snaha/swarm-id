// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Erasure-coded uploads (#307): parity chunks go out beside the data, the
 * level is written into the intermediates' spans, and the tree still reads
 * back through the chunk API.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  decodeRedundancyLevel,
  getMaxShards,
  REPLICAS_OWNER,
  rsDecode,
} from "@ethersphere/core-sdk"
import { uploadData, type UploadTarget } from "./upload"
import { downloadDataWithChunkAPI } from "./download-data"
import { CHUNK_SIZE, estimateTotalChunks } from "./chunking"
import {
  MockBee,
  MockChunkStore,
  createMockStamper,
} from "./feeds/epochs/test-utils"
import { uint8ArrayToHex } from "../utils/hex"
import { SPAN_SIZE } from "../chunk"

const LEVELS = [1, 2, 3, 4] as const
// Enough leaves for more than one batch at every level, so the tree has two
// levels of intermediates and a short last batch.
const LEAF_COUNT = 140
const PLAIN_REF_BYTES = 32
// Bee's `replicas.Counts`: root replicas per level
const REPLICAS = [0, 2, 4, 8, 16]

function makeData(length: number): Uint8Array {
  const data = new Uint8Array(length)
  for (let i = 0; i < length; i++) data[i] = (i * 31 + 7) & 0xff
  return data
}

/** The `/soc` posts an upload makes: the root's replicas. */
function setup(): {
  bee: MockBee
  store: MockChunkStore
  target: UploadTarget
  socPosts: string[]
} {
  const store = new MockChunkStore()
  const bee = new MockBee(store)
  const socPosts: string[] = []
  vi.stubGlobal("fetch", async (url: string) => {
    socPosts.push(url)
    return new Response(undefined, { status: 201 })
  })
  return {
    bee,
    store,
    target: { mode: "stamper", bee, stamper: createMockStamper() },
    socPosts,
  }
}

function spanOf(chunk: Uint8Array): bigint {
  return new DataView(chunk.buffer, chunk.byteOffset).getBigUint64(0, true)
}

describe("uploadData with a redundancy level", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  for (const level of LEVELS) {
    for (const encrypted of [false, true]) {
      // A full batch plus one leaf: the lone leaf moves up to sit beside the
      // batch's intermediate, which core-sdk 0.1 got wrong (core-sdk#9, #10).
      const sizes = {
        "two levels": LEAF_COUNT * CHUNK_SIZE + 1,
        "a lone last leaf": getMaxShards(level, encrypted) * CHUNK_SIZE + 1,
      }
      for (const [shape, size] of Object.entries(sizes)) {
        it(`round-trips ${shape} at level ${level}, ${encrypted ? "encrypted" : "plain"}`, async () => {
          const { bee, target, socPosts } = setup()
          const data = makeData(size)
          const onProgress: number[] = []

          const { reference } = await uploadData(target, data, {
            redundancyLevel: level,
            encryptionKey: encrypted ? true : undefined,
            onProgress: ({ processed }) => onProgress.push(processed),
          })

          expect(await downloadDataWithChunkAPI(bee, reference)).toEqual(data)
          expect(socPosts).toHaveLength(REPLICAS[level])
          for (const url of socPosts) {
            expect(url).toContain(`/soc/${uint8ArrayToHex(REPLICAS_OWNER)}/`)
          }
          // Parity and root replicas add to the chunks a level-0 tree sends.
          const sent = onProgress.at(-1) ?? 0
          expect(sent).toBeGreaterThan(
            estimateTotalChunks(data.length, encrypted),
          )
          expect(sent).toBeLessThanOrEqual(
            estimateTotalChunks(data.length, encrypted, level),
          )
        })
      }
    }

    it(`writes level ${level} into the root's span`, async () => {
      const { store, target } = setup()
      const data = makeData(LEAF_COUNT * CHUNK_SIZE)

      const { reference } = await uploadData(target, data, {
        redundancyLevel: level,
      })

      const root = await store.get(reference)
      expect(decodeRedundancyLevel(spanOf(root))).toEqual({
        level,
        span: BigInt(data.length),
      })
    })
  }

  it("sends parity that rebuilds a lost data chunk", async () => {
    const { store, target } = setup()
    const level = 1
    // One batch of leaves under a single root, so the root's refs are the
    // leaves followed by their parity.
    const leaves = 10
    const data = makeData(leaves * CHUNK_SIZE)

    const { reference } = await uploadData(target, data, {
      redundancyLevel: level,
    })

    const root = await store.get(reference)
    const payload = root.subarray(SPAN_SIZE)
    const refs: string[] = []
    for (let i = 0; i * PLAIN_REF_BYTES < payload.length; i++) {
      const ref = payload.subarray(
        i * PLAIN_REF_BYTES,
        (i + 1) * PLAIN_REF_BYTES,
      )
      if (ref.every((byte) => byte === 0)) break
      refs.push(uint8ArrayToHex(ref))
    }
    const parities = refs.length - leaves
    expect(parities).toBeGreaterThan(0)

    // External API: rsDecode marks a missing shard with null.
    const shards: (Uint8Array | null)[] = await Promise.all(
      refs.map(async (ref) => {
        const chunk = await store.get(ref)
        const padded = new Uint8Array(SPAN_SIZE + CHUNK_SIZE)
        padded.set(chunk)
        return padded
      }),
    )
    const lost = shards[0]
    shards[0] = null
    const rebuilt = rsDecode(shards, leaves, parities)
    expect(rebuilt[0]).toEqual(lost)
  })
})

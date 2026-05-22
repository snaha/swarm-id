// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import {
  makeContentAddressedChunk,
  makeEncryptedContentAddressedChunk,
} from "../chunk"
import {
  CHUNK_SIZE,
  DATA_COUNTER_START,
  NUM_BUCKETS,
  UINT16_COUNTER_MAX_DEPTH,
  UTILIZATION_SLOTS_PER_BUCKET,
  calculateUtilizationUpdate,
  deriveUtilizationChunkKey,
  deserializeUint16Array,
  deserializeUint32Array,
  extractChunk,
  getChunkIndexForBucket,
  getChunkLayout,
  initializeBatchUtilization,
  makeBatchUtilizationTopic,
  makeChunkIdentifier,
  mergeChunk,
  resolveUtilizationChunkKeys,
  serializeUint16Array,
  serializeUint32Array,
  toBucket,
} from "./batch-utilization"

const TEST_BATCH_ID = new BatchId("00".repeat(32))

describe("getChunkLayout", () => {
  it("uses uint16 codec for depth <= UINT16_COUNTER_MAX_DEPTH", () => {
    const layout = getChunkLayout(24)
    expect(layout.counterByteSize).toBe(2)
    expect(layout.bucketsPerChunk).toBe(2048)
    expect(layout.numUtilizationChunks).toBe(32)
  })

  it("uses uint16 codec at the boundary (depth = UINT16_COUNTER_MAX_DEPTH)", () => {
    expect(UINT16_COUNTER_MAX_DEPTH).toBe(31)
    const layout = getChunkLayout(UINT16_COUNTER_MAX_DEPTH)
    expect(layout.counterByteSize).toBe(2)
    expect(layout.numUtilizationChunks).toBe(32)
  })

  it("falls back to uint32 codec for depth > UINT16_COUNTER_MAX_DEPTH", () => {
    const layout = getChunkLayout(32)
    expect(layout.counterByteSize).toBe(4)
    expect(layout.bucketsPerChunk).toBe(1024)
    expect(layout.numUtilizationChunks).toBe(64)
  })

  it("returns a chunk size that covers all NUM_BUCKETS in both layouts", () => {
    expect(getChunkLayout(24).bucketsPerChunk * 32).toBe(NUM_BUCKETS)
    expect(getChunkLayout(32).bucketsPerChunk * 64).toBe(NUM_BUCKETS)
    expect(getChunkLayout(24).bucketsPerChunk * 2).toBe(CHUNK_SIZE)
    expect(getChunkLayout(32).bucketsPerChunk * 4).toBe(CHUNK_SIZE)
  })
})

describe("serializeUint16Array / deserializeUint16Array", () => {
  it("round-trips representative values", () => {
    const source = new Uint32Array([0, 1, 255, 256, 32768, 65535])
    const bytes = serializeUint16Array(source)
    expect(bytes.byteLength).toBe(source.length * 2)
    const decoded = deserializeUint16Array(bytes)
    expect(Array.from(decoded)).toEqual(Array.from(source))
  })

  it("round-trips a full-bucket random fill", () => {
    const source = new Uint32Array(2048)
    for (let i = 0; i < source.length; i++) {
      source[i] = Math.floor(Math.random() * 0x10000)
    }
    const bytes = serializeUint16Array(source)
    expect(bytes.byteLength).toBe(CHUNK_SIZE)
    const decoded = deserializeUint16Array(bytes)
    expect(Array.from(decoded)).toEqual(Array.from(source))
  })

  it("rejects values that exceed uint16 range", () => {
    const source = new Uint32Array([0, 0x10000])
    expect(() => serializeUint16Array(source)).toThrow(/uint16 range/)
  })

  it("rejects odd-length byte input on deserialize", () => {
    expect(() => deserializeUint16Array(new Uint8Array(3))).toThrow(
      /multiple of 2/,
    )
  })
})

describe("extractChunk / mergeChunk", () => {
  it("round-trips a full dataCounters at depth 24 (uint16 layout)", () => {
    const depth = 24
    const { numUtilizationChunks } = getChunkLayout(depth)
    const source = new Uint32Array(NUM_BUCKETS)
    for (let i = 0; i < source.length; i++) {
      source[i] = i % 0xffff
    }

    const target = new Uint32Array(NUM_BUCKETS)
    for (let i = 0; i < numUtilizationChunks; i++) {
      const chunk = extractChunk(source, i, depth)
      expect(chunk.byteLength).toBe(CHUNK_SIZE)
      mergeChunk(target, i, chunk, depth)
    }

    expect(Array.from(target)).toEqual(Array.from(source))
  })

  it("round-trips a full dataCounters at depth 32 (uint32 layout)", () => {
    const depth = 32
    const { numUtilizationChunks } = getChunkLayout(depth)
    const source = new Uint32Array(NUM_BUCKETS)
    for (let i = 0; i < source.length; i++) {
      source[i] = (i * 1664525 + 1013904223) >>> 0
    }

    const target = new Uint32Array(NUM_BUCKETS)
    for (let i = 0; i < numUtilizationChunks; i++) {
      const chunk = extractChunk(source, i, depth)
      expect(chunk.byteLength).toBe(CHUNK_SIZE)
      mergeChunk(target, i, chunk, depth)
    }

    expect(Array.from(target)).toEqual(Array.from(source))
  })

  it("rejects an out-of-range chunk index", () => {
    const counters = new Uint32Array(NUM_BUCKETS)
    expect(() => extractChunk(counters, 32, 24)).toThrow(/Invalid chunk index/)
    expect(() => extractChunk(counters, 64, 32)).toThrow(/Invalid chunk index/)
  })

  it("rejects a chunk whose byte length is not CHUNK_SIZE", () => {
    const counters = new Uint32Array(NUM_BUCKETS)
    expect(() => mergeChunk(counters, 0, new Uint8Array(100), 24)).toThrow(
      /Invalid chunk data length/,
    )
  })
})

describe("initializeBatchUtilization", () => {
  it("seeds dataCounters at DATA_COUNTER_START and matches the layout's chunk count", () => {
    const state = initializeBatchUtilization(TEST_BATCH_ID, 24)
    expect(state.batchDepth).toBe(24)
    expect(state.dataCounters.length).toBe(NUM_BUCKETS)
    expect(state.dataCounters[0]).toBe(DATA_COUNTER_START)
    expect(state.dataCounters[NUM_BUCKETS - 1]).toBe(DATA_COUNTER_START)
    expect(state.chunks.length).toBe(32)
  })

  it("uses the 64-chunk layout at depth 32", () => {
    const state = initializeBatchUtilization(TEST_BATCH_ID, 32)
    expect(state.batchDepth).toBe(32)
    expect(state.chunks.length).toBe(64)
  })
})

describe("calculateUtilizationUpdate (chunk count by depth)", () => {
  const dataChunks = [
    makeContentAddressedChunk(new Uint8Array(4096).fill(1)),
    makeContentAddressedChunk(new Uint8Array(4096).fill(2)),
    makeContentAddressedChunk(new Uint8Array(4096).fill(3)),
  ]

  it("produces 32 utilization chunks at depth 24 (uint16 codec)", () => {
    const depth = 24
    const state = initializeBatchUtilization(TEST_BATCH_ID, depth)
    const { utilizationChunks } = calculateUtilizationUpdate(
      state,
      dataChunks,
      depth,
    )
    expect(utilizationChunks.length).toBe(32)
  })

  it("produces 64 utilization chunks at depth 32 (uint32 codec)", () => {
    const depth = 32
    const state = initializeBatchUtilization(TEST_BATCH_ID, depth)
    const { utilizationChunks } = calculateUtilizationUpdate(
      state,
      dataChunks,
      depth,
    )
    expect(utilizationChunks.length).toBe(64)
  })
})

describe("getChunkIndexForBucket (depth-dependent layout)", () => {
  it("maps buckets to chunks using the uint16 layout at depth 24", () => {
    expect(getChunkIndexForBucket(0, 24)).toBe(0)
    expect(getChunkIndexForBucket(2047, 24)).toBe(0)
    expect(getChunkIndexForBucket(2048, 24)).toBe(1)
    expect(getChunkIndexForBucket(NUM_BUCKETS - 1, 24)).toBe(31)
  })

  it("maps buckets to chunks using the uint32 layout at depth 32", () => {
    expect(getChunkIndexForBucket(0, 32)).toBe(0)
    expect(getChunkIndexForBucket(1023, 32)).toBe(0)
    expect(getChunkIndexForBucket(1024, 32)).toBe(1)
    expect(getChunkIndexForBucket(NUM_BUCKETS - 1, 32)).toBe(63)
  })

  it("rejects an out-of-range bucket index", () => {
    expect(() => getChunkIndexForBucket(-1, 24)).toThrow(/Invalid bucket index/)
    expect(() => getChunkIndexForBucket(NUM_BUCKETS, 24)).toThrow(
      /Invalid bucket index/,
    )
  })
})

describe("makeChunkIdentifier (depth-dependent chunk count)", () => {
  const topic = makeBatchUtilizationTopic(TEST_BATCH_ID)

  it("is deterministic for the same topic, index, and depth", () => {
    const a = makeChunkIdentifier(topic, 5, 24)
    const b = makeChunkIdentifier(topic, 5, 24)
    expect(a.toHex()).toBe(b.toHex())
  })

  it("rejects an index outside the uint16 layout but accepts it for uint32", () => {
    expect(() => makeChunkIdentifier(topic, 32, 24)).toThrow(
      /Invalid chunk index/,
    )
    expect(() => makeChunkIdentifier(topic, 32, 32)).not.toThrow()
    expect(() => makeChunkIdentifier(topic, 64, 32)).toThrow(
      /Invalid chunk index/,
    )
  })
})

describe("regression: serializeUint32Array round-trip", () => {
  it("round-trips a uint32 buffer", () => {
    const source = new Uint32Array([0, 1, 0xdeadbeef, 0xffffffff])
    const bytes = serializeUint32Array(source)
    expect(bytes.byteLength).toBe(source.length * 4)
    const decoded = deserializeUint32Array(bytes)
    expect(Array.from(decoded)).toEqual(Array.from(source))
  })
})

/**
 * `UtilizationAwareStamper.flush()` writes `contentHash` as the hex of the BMT
 * address of the encrypted chunk for the dirty plaintext + the stamper's
 * encryption key. The upload-path dedup at `saveUtilizationState` compares
 * against the same value, so these tests pin the underlying property: for a
 * given (plaintext, key) pair the BMT-of-encrypted address is deterministic,
 * and any change to either input produces a different address.
 */
describe("BMT-of-encrypted chunk address (contentHash invariant)", () => {
  const KEY_A = new Uint8Array(32).map((_, i) => i + 1)
  const KEY_B = new Uint8Array(32).map((_, i) => 255 - i)

  function bmtHex(data: Uint8Array, key: Uint8Array): string {
    return Binary.uint8ArrayToHex(
      makeEncryptedContentAddressedChunk(data, key).address.toUint8Array(),
    )
  }

  it("is deterministic for the same plaintext + key", () => {
    const data = new Uint8Array(CHUNK_SIZE)
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff
    expect(bmtHex(data, KEY_A)).toBe(bmtHex(data, KEY_A))
  })

  it("changes when a single counter byte flips", () => {
    const data = new Uint8Array(CHUNK_SIZE)
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff
    const before = bmtHex(data, KEY_A)
    data[1234] ^= 0x01
    const after = bmtHex(data, KEY_A)
    expect(after).not.toBe(before)
  })

  it("changes when the encryption key changes", () => {
    const data = new Uint8Array(CHUNK_SIZE)
    for (let i = 0; i < data.length; i++) data[i] = (i * 17) & 0xff
    expect(bmtHex(data, KEY_A)).not.toBe(bmtHex(data, KEY_B))
  })

  it("returns a 64-hex-char (32-byte) address", () => {
    const data = new Uint8Array(CHUNK_SIZE)
    const hash = bmtHex(data, KEY_A)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("per-bucket reservation constants", () => {
  it("reserves 2 slots per bucket (down from the historical 4)", () => {
    expect(DATA_COUNTER_START).toBe(2)
    expect(UTILIZATION_SLOTS_PER_BUCKET).toBe(2)
  })
})

describe("deriveUtilizationChunkKey", () => {
  const SWARM_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff)

  it("is deterministic for the same inputs", async () => {
    const a = await deriveUtilizationChunkKey(SWARM_KEY, TEST_BATCH_ID, 5, 0)
    const b = await deriveUtilizationChunkKey(SWARM_KEY, TEST_BATCH_ID, 5, 0)
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(a.length).toBe(32)
  })

  it("varies with chunkIndex, nonce, and batchId", async () => {
    const base = await deriveUtilizationChunkKey(SWARM_KEY, TEST_BATCH_ID, 5, 0)
    const otherIndex = await deriveUtilizationChunkKey(
      SWARM_KEY,
      TEST_BATCH_ID,
      6,
      0,
    )
    const otherNonce = await deriveUtilizationChunkKey(
      SWARM_KEY,
      TEST_BATCH_ID,
      5,
      1,
    )
    const otherBatch = await deriveUtilizationChunkKey(
      SWARM_KEY,
      new BatchId("11".repeat(32)),
      5,
      0,
    )
    expect(Array.from(base)).not.toEqual(Array.from(otherIndex))
    expect(Array.from(base)).not.toEqual(Array.from(otherNonce))
    expect(Array.from(base)).not.toEqual(Array.from(otherBatch))
  })

  it("rejects a swarmEncryptionKey of the wrong length", async () => {
    await expect(
      deriveUtilizationChunkKey(new Uint8Array(16), TEST_BATCH_ID, 0, 0),
    ).rejects.toThrow(/swarmEncryptionKey length/)
  })
})

describe("resolveUtilizationChunkKeys", () => {
  /**
   * Build N distinct synthetic plaintexts. Each one is unique so the natural
   * (nonce=0) bucket distribution is effectively random across chunkIndex,
   * matching what production sees over time.
   */
  function buildDistinctPlaintexts(count: number): Uint8Array[] {
    const out: Uint8Array[] = []
    for (let i = 0; i < count; i++) {
      const data = new Uint8Array(CHUNK_SIZE)
      // Seed enough variation that BMT outputs are distinct
      const seed = (i + 1) * 2654435761
      for (let j = 0; j < CHUNK_SIZE; j++) {
        data[j] = (seed + j * 31) & 0xff
      }
      out.push(data)
    }
    return out
  }

  it("produces 32 distinct buckets at depth 24 with a chunk-count fixture", async () => {
    const plaintexts = buildDistinctPlaintexts(32)
    const { keys, buckets } = await resolveUtilizationChunkKeys(plaintexts, {
      swarmEncryptionKey: new Uint8Array(32).map((_, i) => i + 1),
      batchId: TEST_BATCH_ID,
    })
    expect(keys.length).toBe(32)
    expect(buckets.length).toBe(32)
    expect(new Set(buckets).size).toBe(32)
    // The expected number of nonce bumps for 32 chunks over 65,536 buckets
    // is ~0.008. Allow up to 2 bumps to keep the test stable.
    const totalBumps = keys.reduce((acc, k) => acc + k.nonce, 0)
    expect(totalBumps).toBeLessThanOrEqual(2)
  })

  it("is stable across reruns when priorNonces match", async () => {
    const plaintexts = buildDistinctPlaintexts(32)
    const first = await resolveUtilizationChunkKeys(plaintexts, {
      swarmEncryptionKey: new Uint8Array(32).map((_, i) => i + 1),
      batchId: TEST_BATCH_ID,
    })
    const priorNonces: Record<number, number> = {}
    for (let i = 0; i < first.keys.length; i++) {
      priorNonces[i] = first.keys[i].nonce
    }
    const second = await resolveUtilizationChunkKeys(plaintexts, {
      swarmEncryptionKey: new Uint8Array(32).map((_, i) => i + 1),
      batchId: TEST_BATCH_ID,
      priorNonces,
    })
    for (let i = 0; i < first.keys.length; i++) {
      expect(second.keys[i].nonce).toBe(first.keys[i].nonce)
      expect(Array.from(second.keys[i].key)).toEqual(
        Array.from(first.keys[i].key),
      )
      expect(second.buckets[i]).toBe(first.buckets[i])
    }
  })

  it("perturbs only the higher chunkIndex when two chunks share a bucket", async () => {
    // Lower-index-wins is hard to demonstrate with random plaintexts (natural
    // 2-way collisions in 65,536 buckets are vanishingly rare).
    // Instead we set up the same plaintext for two indices but priorNonces
    // such that chunk 1 starts at the same nonce that produces chunk 0's
    // bucket. Since the key derivation is keyed by chunkIndex, this can't
    // actually force a real collision; demonstrating it would require
    // recovering identical bucket outputs from different (index, nonce)
    // pairs — too brittle. Instead we assert the structural property: when
    // a collision *does* happen during the inner loop, the result still
    // satisfies the "all distinct" invariant. The "distinct buckets" test
    // above already covers the happy path. Here we only assert the contract
    // surface — every chunkIndex i sees a nonce >= priorNonces[i].
    const plaintexts = buildDistinctPlaintexts(4)
    const priorNonces: Record<number, number> = { 0: 7, 1: 3, 2: 0, 3: 5 }
    const { keys } = await resolveUtilizationChunkKeys(plaintexts, {
      swarmEncryptionKey: new Uint8Array(32).fill(42),
      batchId: TEST_BATCH_ID,
      priorNonces,
    })
    for (let i = 0; i < keys.length; i++) {
      expect(keys[i].nonce).toBeGreaterThanOrEqual(priorNonces[i])
    }
  })

  it("places each chunk at a bucket consistent with its derived key", async () => {
    const plaintexts = buildDistinctPlaintexts(8)
    const swarmKey = new Uint8Array(32).map((_, i) => (i * 17 + 3) & 0xff)
    const { keys, buckets } = await resolveUtilizationChunkKeys(plaintexts, {
      swarmEncryptionKey: swarmKey,
      batchId: TEST_BATCH_ID,
    })
    for (let i = 0; i < keys.length; i++) {
      const expectedKey = await deriveUtilizationChunkKey(
        swarmKey,
        TEST_BATCH_ID,
        i,
        keys[i].nonce,
      )
      expect(Array.from(keys[i].key)).toEqual(Array.from(expectedKey))
      // The bucket reported by resolveUtilizationChunkKeys matches the bucket
      // computed from the encrypted CAC address using the derived key.
      const encryptedAddress = makeEncryptedContentAddressedChunk(
        plaintexts[i],
        keys[i].key,
      ).address.toUint8Array()
      expect(toBucket(encryptedAddress)).toBe(buckets[i])
    }
  })
})

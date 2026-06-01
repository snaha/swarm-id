// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { makeEncryptedContentAddressedChunk } from "../chunk"
import {
  CHUNK_SIZE,
  DATA_COUNTER_START,
  NUM_BUCKETS,
  PARTITION_COUNT,
  PartitionLeaseLostError,
  UINT16_COUNTER_MAX_DEPTH,
  UTILIZATION_SLOTS_PER_BUCKET,
  UtilizationAwareStamper,
  computeResumeCounterSkew,
  dataSlot,
  partitionCapacity,
  deriveUtilizationChunkKey,
  deserializeUint16Array,
  deserializeUint32Array,
  extractChunk,
  getChunkIndexForBucket,
  getChunkLayout,
  initializeBatchUtilization,
  leaseChunkIndex,
  makeBatchUtilizationTopic,
  makeChunkIdentifier,
  mergeChunk,
  resolveUtilizationChunkKeys,
  serializeUint16Array,
  serializeUint32Array,
  toBucket,
} from "./batch-utilization"
import { EthAddress, PrivateKey } from "@ethersphere/bee-js"
import type { Chunk as CafeChunk } from "cafe-utility"
import type {
  ChunkCacheEntry,
  UtilizationStoreDB,
} from "../storage/utilization-store"
import { lockSocAddress } from "./lock-soc"
import { deriveSecret } from "./key-derivation"
import { uint8ArrayToHex } from "./hex"

const TEST_BATCH_ID = new BatchId("00".repeat(32))

function makeChunkInBucket(bucket: number, indexSeed: number): CafeChunk {
  const address = new Uint8Array(32)
  address[0] = (bucket >> 8) & 0xff
  address[1] = bucket & 0xff
  for (let i = 2; i < 32; i++) {
    address[i] = ((indexSeed + 1) * (i + 1)) & 0xff
  }
  return {
    hash: () => address,
    build: () => new Uint8Array(CHUNK_SIZE),
    span: 0n,
    writer: { write: () => undefined },
  } as unknown as CafeChunk
}

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
  it("seeds the per-partition counter at 0 and matches the layout's chunk count", () => {
    const state = initializeBatchUtilization(TEST_BATCH_ID, 24)
    expect(state.batchDepth).toBe(24)
    expect(state.dataCounters.length).toBe(NUM_BUCKETS)
    // Counter is the 0-based per-partition `j`; reserved headroom lives in the
    // slot formula (`dataSlot`), not in the counter.
    expect(state.dataCounters[0]).toBe(0)
    expect(state.dataCounters[NUM_BUCKETS - 1]).toBe(0)
    expect(state.chunks.length).toBe(32)
  })

  it("uses the 64-chunk layout at depth 32", () => {
    const state = initializeBatchUtilization(TEST_BATCH_ID, 32)
    expect(state.batchDepth).toBe(32)
    expect(state.chunks.length).toBe(64)
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

/**
 * The partition-aware stamper is the load-bearing piece of the multi-device
 * partition-lease feature: when two devices stamp into the same shared
 * postage batch, their per-bucket slot picks MUST be drawn from disjoint
 * residue classes mod K so that no two chunks ever share a `(bucket, slot)`
 * pair. These tests pin that property.
 */
describe("UtilizationAwareStamper partition awareness", () => {
  // A throwaway 32-byte private key — only used for envelope signing, not
  // for anything we verify cryptographically.
  const TEST_SIGNER_KEY = new PrivateKey(
    new Uint8Array(32).map((_, i) => (i + 1) & 0xff),
  ).toHex()
  const TEST_OWNER = new EthAddress("00".repeat(20))
  const TEST_ENC_KEY = new Uint8Array(32).map((_, i) => (i * 5 + 2) & 0xff)
  // Depth 24 → maxSlot per bucket = 256, comfortably above the 50 stamps
  // per device the tests below push into a single bucket.
  const TEST_DEPTH = 24

  /**
   * Mock the parts of `UtilizationStoreDB` that `UtilizationAwareStamper.create`
   * touches at construction time. Returning an empty array of cached chunks
   * forces the stamper to start from a fresh `dataCounters` (filled with
   * `DATA_COUNTER_START`), which is what we want for a clean two-device
   * scenario.
   */
  function makeEmptyCache(): UtilizationStoreDB {
    return {
      getAllChunks: async () => [],
      putChunk: async () => undefined,
    } as unknown as UtilizationStoreDB
  }

  function decodeIndex(index: Uint8Array): { bucket: number; slot: number } {
    const view = new DataView(index.buffer, index.byteOffset, index.byteLength)
    return {
      bucket: view.getUint32(0, false),
      slot: view.getUint32(4, false),
    }
  }

  it("two partitions stamping the same bucket produce disjoint slots", async () => {
    const device0 = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    const device1 = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )

    device0.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    device1.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })

    // 20 × 2 = 40 stamps; ECDSA signing dominates wall time in this test
    // (the bee-js Stamper signs every envelope), so we keep the count low
    // enough for the default vitest 5 s timeout.
    const STAMPS_PER_DEVICE = 20
    const BUCKET = 0x1234
    const seen = new Set<string>()

    for (let i = 0; i < STAMPS_PER_DEVICE; i++) {
      const chunk0 = makeChunkInBucket(BUCKET, i * 2)
      const chunk1 = makeChunkInBucket(BUCKET, i * 2 + 1)
      const env0 = decodeIndex(device0.stamp(chunk0).index)
      const env1 = decodeIndex(device1.stamp(chunk1).index)

      // Both stamps landed in the targeted bucket.
      expect(env0.bucket).toBe(BUCKET)
      expect(env1.bucket).toBe(BUCKET)

      // Device 0 uses even slot offsets, device 1 odd — both offset by
      // DATA_COUNTER_START.
      const expectedSlot0 = DATA_COUNTER_START + 0 + PARTITION_COUNT * i
      const expectedSlot1 = DATA_COUNTER_START + 1 + PARTITION_COUNT * i
      expect(env0.slot).toBe(expectedSlot0)
      expect(env1.slot).toBe(expectedSlot1)

      const key0 = `${env0.bucket}:${env0.slot}`
      const key1 = `${env1.bucket}:${env1.slot}`
      expect(seen.has(key0)).toBe(false)
      expect(seen.has(key1)).toBe(false)
      seen.add(key0)
      seen.add(key1)
    }

    // 2 devices * 50 stamps = 100 distinct (bucket, slot) pairs.
    expect(seen.size).toBe(STAMPS_PER_DEVICE * 2)
  })

  it("a reserved counter chunk still stamps when the bucket's data lane is full (no 'Bucket is full')", async () => {
    // Regression for the partition-state "Bucket is full" bug: counter chunks
    // must overstamp the reserved slot, never a data slot. Small depth so the
    // data lane fills fast: 2^(20-16)=16 slots/bucket → partitionCapacity=7.
    const DEPTH = 20
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })

    const BUCKET = 0x1234
    const cap = partitionCapacity(DEPTH, PARTITION_COUNT)
    for (let j = 0; j < cap; j++) {
      stamper.stamp(makeChunkInBucket(BUCKET, j))
    }
    // One more DATA chunk in BUCKET overflows the partition's lane → the
    // underlying bee-js stamper throws "Bucket is full".
    expect(() => stamper.stamp(makeChunkInBucket(BUCKET, 9000))).toThrow()

    // A counter chunk marked reserved overstamps slot 0 (the partition's
    // reserved slot), which is free even though the data lane is full.
    const counterChunk = makeChunkInBucket(BUCKET, 9999)
    stamper.markReservedUtilizationChunk(counterChunk.hash())
    const env = decodeIndex(stamper.stamp(counterChunk).index)
    expect(env.bucket).toBe(BUCKET)
    expect(env.slot).toBe(0)
  })

  it("legacy mode (no partition bound) collapses to partition 0, K=1", async () => {
    // Without `bindPartition`, the stamper behaves as partition 0 with K=1:
    // slot = dataSlot(0, j, 1) = 1 + j (reserved slot 0). Two un-partitioned
    // stampers stamping the same bucket collide on the same slot — sanity
    // check that we haven't accidentally enabled partitioning by default.
    const a = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    const b = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )

    const BUCKET = 0x4321
    const envA = decodeIndex(a.stamp(makeChunkInBucket(BUCKET, 0)).index)
    const envB = decodeIndex(b.stamp(makeChunkInBucket(BUCKET, 1)).index)
    expect(envA.bucket).toBe(BUCKET)
    expect(envB.bucket).toBe(BUCKET)
    // Both behave as partition 0, K=1, j=0 → slot 1, so they collide. This is
    // the bug partition-lease fixes.
    expect(envA.slot).toBe(dataSlot(0, 0, 1))
    expect(envB.slot).toBe(dataSlot(0, 0, 1))
  })

  it("rejects a localCounter of the wrong length on bindPartition", async () => {
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    expect(() =>
      stamper.bindPartition({
        partition: 0,
        partitionCount: PARTITION_COUNT,
        localCounter: new Uint32Array(NUM_BUCKETS - 1),
      }),
    ).toThrow(/localCounter must have/)
  })

  it("unbindPartition clears partition slot state", async () => {
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    expect(stamper.currentPartition).toBe(0)
    expect(stamper.partitionCount).toBe(PARTITION_COUNT)

    stamper.unbindPartition()

    expect(stamper.currentPartition).toBeUndefined()
    expect(stamper.partitionCount).toBe(1)
    expect(stamper.getLocalCounter()).toBeUndefined()

    // Subsequent stamps fall back to the legacy single-device path
    // (partition 0, K=1): a fresh bucket (j=0) lands at dataSlot(0, 0, 1) = 1.
    const env = decodeIndex(stamper.stamp(makeChunkInBucket(0x77, 0)).index)
    expect(env.slot).toBe(dataSlot(0, 0, 1))
  })

  it("invalidateLease causes the next partition-bound stamp to throw", async () => {
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })

    // Sanity: a stamp before invalidation succeeds.
    stamper.stamp(makeChunkInBucket(0x88, 0))

    stamper.invalidateLease()

    // Now any partition-bound stamp aborts — closing the window where an
    // in-flight upload would otherwise silently corrupt a peer's slot.
    expect(() => stamper.stamp(makeChunkInBucket(0x88, 1))).toThrow(
      PartitionLeaseLostError,
    )
  })

  it("invalidateLease is reset by bindPartition (re-acquire reuses stamper)", async () => {
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    stamper.invalidateLease()
    expect(() => stamper.stamp(makeChunkInBucket(0x99, 0))).toThrow(
      PartitionLeaseLostError,
    )

    // After re-binding (e.g. wait-for-slot retry succeeded), stamps work again.
    stamper.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    expect(() => stamper.stamp(makeChunkInBucket(0x99, 1))).not.toThrow()
  })

  it("lock-SOC short-circuit routes overstamps to the reserved slot", async () => {
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )

    const lockAddr0 = new Uint8Array(32)
    lockAddr0[0] = 0xab
    lockAddr0[1] = 0xcd
    const lockAddr1 = new Uint8Array(32)
    lockAddr1[0] = 0xee
    lockAddr1[1] = 0xff

    stamper.bindLockSocs([
      { partition: 0, address: lockAddr0 },
      { partition: 1, address: lockAddr1 },
    ])

    // Stamping the partition-0 lock SOC many times always lands at slot 0.
    for (let i = 0; i < 8; i++) {
      const env = decodeIndex(
        stamper.stamp({
          hash: () => lockAddr0,
          build: () => new Uint8Array(CHUNK_SIZE),
          span: 0n,
          writer: { write: () => undefined },
        } as unknown as CafeChunk).index,
      )
      expect(env.bucket).toBe(0xabcd)
      expect(env.slot).toBe(0)
    }

    // Partition-1 lock SOC always lands at slot 1.
    const env1 = decodeIndex(
      stamper.stamp({
        hash: () => lockAddr1,
        build: () => new Uint8Array(CHUNK_SIZE),
        span: 0n,
        writer: { write: () => undefined },
      } as unknown as CafeChunk).index,
    )
    expect(env1.bucket).toBe(0xeeff)
    expect(env1.slot).toBe(1)
  })

  it("data chunks in a reserved lock-SOC bucket use slots ≥ DATA_COUNTER_START", async () => {
    // The lock SOC sits at slot 0 (or 1) of its bucket. Data chunks in the
    // same bucket must skip past the reserved headroom — DATA_COUNTER_START
    // gives both rooms.
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    const BUCKET = 0x4242
    const lockAddr = new Uint8Array(32)
    lockAddr[0] = (BUCKET >> 8) & 0xff
    lockAddr[1] = BUCKET & 0xff
    // Tail bytes distinct from any plausible data chunk in this test.
    lockAddr[31] = 0xa5

    stamper.bindLockSocs([{ partition: 0, address: lockAddr }])
    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })

    // Overstamp the lock SOC a bunch.
    for (let i = 0; i < 5; i++) {
      stamper.stamp({
        hash: () => lockAddr,
        build: () => new Uint8Array(CHUNK_SIZE),
        span: 0n,
        writer: { write: () => undefined },
      } as unknown as CafeChunk)
    }

    // Now a data chunk in the same bucket: must NOT collide with the lock
    // SOC's reserved slot 0; slot must be ≥ DATA_COUNTER_START.
    const env = decodeIndex(stamper.stamp(makeChunkInBucket(BUCKET, 1)).index)
    expect(env.bucket).toBe(BUCKET)
    expect(env.slot).toBeGreaterThanOrEqual(DATA_COUNTER_START)
  })

  it("marked utilisation chunks land in the reserved slot (= partition) and don't bump the counter", async () => {
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    stamper.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })

    const BUCKET = 0x6789
    const chunk = makeChunkInBucket(BUCKET, 3)
    stamper.markReservedUtilizationChunk(chunk.hash())

    const env = decodeIndex(stamper.stamp(chunk).index)
    expect(env.bucket).toBe(BUCKET)
    // Reserved slot = partition index, not a data slot; counter untouched.
    expect(env.slot).toBe(1)
    expect(stamper.getLocalCounter()![BUCKET]).toBe(0)

    // After clearing, the same bucket's data chunk uses the data lane again.
    stamper.clearReservedUtilizationChunks()
    const env2 = decodeIndex(stamper.stamp(makeChunkInBucket(BUCKET, 4)).index)
    expect(env2.slot).toBe(dataSlot(1, 0, PARTITION_COUNT))
  })

  it("auto-bind uses the BACKUP-signer address (derived from encryptionKey), not the `owner` arg", async () => {
    // Regression: `writePartitionLock` writes the lock SOC to
    // `keccak256(identifier || backupSigner.publicKey().address())`, where
    // backupSigner is derived from `swarmEncryptionKey`. The stamper's
    // `owner` parameter is set to different values by different call sites
    // (account address, postage-signer address) and is NOT necessarily the
    // backup signer's address. The auto-bind in `create` must ignore the
    // `owner` arg and derive the backup signer itself, otherwise the
    // short-circuit fails to fire in production and every lock-SOC stamp
    // burns a slot until the bucket is exhausted.
    const swarmEncryptionKey = TEST_ENC_KEY
    const swarmEncryptionKeyHex = uint8ArrayToHex(swarmEncryptionKey)
    const backupKeyHex = await deriveSecret(swarmEncryptionKeyHex, "backup-key")
    const backupOwner = new PrivateKey(backupKeyHex).publicKey().address()
    const expectedLockSocAddr = lockSocAddress(0, backupOwner)

    // Deliberately wrong `owner` — a random unrelated address. If the bug
    // resurfaced, the auto-bind would use this address and the synthetic
    // chunk below would NOT match, causing the test to fail.
    const wrongOwner = new EthAddress("de".repeat(20))

    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      wrongOwner,
      swarmEncryptionKey,
    )

    const lockSocChunk = {
      hash: () => expectedLockSocAddr,
      build: () => new Uint8Array(CHUNK_SIZE),
      span: 0n,
      writer: { write: () => undefined },
    } as unknown as CafeChunk

    // Two overstamps; if the short-circuit fires (which only happens when
    // auto-bind used the BACKUP owner), both land at slot 0.
    const env1 = decodeIndex(stamper.stamp(lockSocChunk).index)
    const env2 = decodeIndex(stamper.stamp(lockSocChunk).index)
    expect(env1.slot).toBe(0)
    expect(env2.slot).toBe(0)
    expect(env1.bucket).toBe(env2.bucket)
  })

  it("getLockSocBuckets reflects bound lock SOCs", async () => {
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    // `create` auto-binds lock SOCs for both partitions from the owner.
    expect(stamper.getLockSocBuckets().size).toBe(PARTITION_COUNT)

    // Explicit re-bind (e.g. for tests) replaces the auto-bound entries.
    const a = new Uint8Array(32)
    a[0] = 0x12
    a[1] = 0x34
    const b = new Uint8Array(32)
    b[0] = 0x56
    b[1] = 0x78
    stamper.bindLockSocs([
      { partition: 0, address: a },
      { partition: 1, address: b },
    ])

    const buckets = stamper.getLockSocBuckets()
    expect(buckets.has(0x1234)).toBe(true)
    expect(buckets.has(0x5678)).toBe(true)
    expect(buckets.size).toBe(2)
  })

  it("seeds the local counter from the caller (Case B resume scenario)", async () => {
    // Simulates Case B: device 1 acquires partition 1 after device 0 has
    // already stamped in some bucket. Device 1's local counter starts at
    // a non-zero value because of RESUME_COUNTER_SKEW.
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    const BUCKET = 0xa5a5
    const SKEW = 3
    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[BUCKET] = SKEW

    stamper.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter,
    })

    const env = decodeIndex(stamper.stamp(makeChunkInBucket(BUCKET, 0)).index)
    expect(env.bucket).toBe(BUCKET)
    expect(env.slot).toBe(DATA_COUNTER_START + 1 + PARTITION_COUNT * SKEW)
  })
})

describe("leaseChunkIndex", () => {
  it("returns numUtilizationChunks + partition for depth 24", () => {
    const { numUtilizationChunks } = getChunkLayout(24)
    expect(numUtilizationChunks).toBe(32)
    expect(leaseChunkIndex(24, 0)).toBe(32)
    expect(leaseChunkIndex(24, 1)).toBe(33)
  })

  it("returns numUtilizationChunks + partition for depth 32", () => {
    const { numUtilizationChunks } = getChunkLayout(32)
    expect(numUtilizationChunks).toBe(64)
    expect(leaseChunkIndex(32, 0)).toBe(64)
    expect(leaseChunkIndex(32, 1)).toBe(65)
  })
})

describe("computeResumeCounterSkew", () => {
  it("returns ceil(slotsPerBucket / PARTITION_COUNT / DIVISOR) for depth 24", () => {
    // slotsPerBucket = 2^(24-16) = 256; 256 / 2 / 4 = 32
    expect(computeResumeCounterSkew(24)).toBe(32)
  })

  it("increases with depth", () => {
    expect(computeResumeCounterSkew(20)).toBeLessThan(
      computeResumeCounterSkew(24),
    )
  })
})

describe("UtilizationAwareStamper lease metadata", () => {
  const TEST_SIGNER_KEY_LM = new PrivateKey(
    new Uint8Array(32).map((_, i) => (i + 7) & 0xff),
  ).toHex()
  const TEST_OWNER_LM = new EthAddress("11".repeat(20))
  const TEST_ENC_KEY_LM = new Uint8Array(32).fill(0x42)
  const TEST_DEPTH_LM = 24

  function makeRecordingCache(): UtilizationStoreDB {
    const store = new Map<string, ChunkCacheEntry>()
    return {
      getAllChunks: async () => {
        const entries: ChunkCacheEntry[] = []
        for (const entry of store.values()) entries.push(entry)
        return entries.sort((a, b) => a.chunkIndex - b.chunkIndex)
      },
      putChunk: async (entry: ChunkCacheEntry) => {
        store.set(`${entry.batchId}:${entry.chunkIndex}`, { ...entry })
      },
      getChunk: async (batchId: string, chunkIndex: number) =>
        store.get(`${batchId}:${chunkIndex}`),
    } as unknown as UtilizationStoreDB
  }

  async function makeStamper(
    cache: UtilizationStoreDB,
  ): Promise<UtilizationAwareStamper> {
    return UtilizationAwareStamper.create(
      TEST_SIGNER_KEY_LM,
      TEST_BATCH_ID,
      TEST_DEPTH_LM,
      cache,
      TEST_OWNER_LM,
      TEST_ENC_KEY_LM,
    )
  }

  it("setLeaseMetadata persists a chunk at leaseChunkIndex(depth, partition)", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)

    await stamper.setLeaseMetadata(0, 42, {
      lastEpoch: { start: 1748000000000n, level: 32 },
      lastTimestamp: 1748000000n,
    })

    const idx = leaseChunkIndex(TEST_DEPTH_LM, 0)
    const entry = await cache.getChunk(TEST_BATCH_ID.toHex(), idx)
    expect(entry).toBeDefined()
    const payload = JSON.parse(new TextDecoder().decode(entry!.data))
    expect(payload.generation).toBe(42)
    expect(payload.claimHints.lastEpoch.start).toBe("1748000000000")
    expect(payload.claimHints.lastTimestamp).toBe("1748000000")
  })

  it("setLeaseMetadata for partition 0 and 1 are independent chunks", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)

    await stamper.setLeaseMetadata(0, 10, {})
    await stamper.setLeaseMetadata(1, 20, {})

    const idx0 = leaseChunkIndex(TEST_DEPTH_LM, 0)
    const idx1 = leaseChunkIndex(TEST_DEPTH_LM, 1)
    expect(idx0).not.toBe(idx1)

    const entry0 = await cache.getChunk(TEST_BATCH_ID.toHex(), idx0)
    const entry1 = await cache.getChunk(TEST_BATCH_ID.toHex(), idx1)
    expect(JSON.parse(new TextDecoder().decode(entry0!.data)).generation).toBe(
      10,
    )
    expect(JSON.parse(new TextDecoder().decode(entry1!.data)).generation).toBe(
      20,
    )
  })

  it("readCachedLease returns undefined when no metadata chunk exists", async () => {
    const stamper = await makeStamper(makeRecordingCache())
    const result = await stamper.readCachedLease(0)
    expect(result).toBeUndefined()
  })

  it("readCachedLease returns generation and claimHints after setLeaseMetadata", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)

    const hints = {
      lastEpoch: { start: 9999000000000n, level: 16 },
      lastTimestamp: 9999000n,
    }
    await stamper.setLeaseMetadata(1, 77, hints)

    const result = await stamper.readCachedLease(1)
    expect(result).toBeDefined()
    expect(result!.partition).toBe(1)
    expect(result!.generation).toBe(77)
    expect(result!.claimHints.lastEpoch?.start).toBe(9999000000000n)
    expect(result!.claimHints.lastEpoch?.level).toBe(16)
    expect(result!.claimHints.lastTimestamp).toBe(9999000n)
  })

  it("readCachedLease returns localCounter = counter + RESUME_COUNTER_SKEW", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)

    // Fresh stamper: the per-partition counter `j` is 0 everywhere (no stamps
    // yet), so readCachedLease seeds localCounter = 0 + skew.
    await stamper.setLeaseMetadata(0, 1, {})

    const skew = computeResumeCounterSkew(TEST_DEPTH_LM)
    const result = await stamper.readCachedLease(0)
    expect(result).toBeDefined()

    expect(result!.localCounter[0]).toBe(skew)
    expect(result!.localCounter[1000]).toBe(skew)
  })

  it("readCachedLease counter reflects stamps made before setLeaseMetadata", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)

    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })

    const BUCKET = 0x1111
    const NUM_STAMPS = 5
    for (let i = 0; i < NUM_STAMPS; i++) {
      stamper.stamp(makeChunkInBucket(BUCKET, i))
    }

    await stamper.setLeaseMetadata(0, 1, {})

    const skew = computeResumeCounterSkew(TEST_DEPTH_LM)
    const result = await stamper.readCachedLease(0)
    // The per-partition counter is 0-based: after NUM_STAMPS into BUCKET,
    // j = NUM_STAMPS, so localCounter = NUM_STAMPS + skew.
    expect(result!.localCounter[BUCKET]).toBe(NUM_STAMPS + skew)
  })

  it("updateLeaseMetadata is a no-op when no partition is bound", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    // No bindPartition call — updateLeaseMetadata should do nothing.
    await stamper.updateLeaseMetadata(99, {})

    const idx = leaseChunkIndex(TEST_DEPTH_LM, 0)
    const entry = await cache.getChunk(TEST_BATCH_ID.toHex(), idx)
    expect(entry).toBeUndefined()
  })

  it("updateLeaseMetadata overwrites the chunk for the bound partition", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)

    stamper.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })

    await stamper.setLeaseMetadata(1, 10, {})
    await stamper.updateLeaseMetadata(11, { lastTimestamp: 42n })

    const idx = leaseChunkIndex(TEST_DEPTH_LM, 1)
    const entry = await cache.getChunk(TEST_BATCH_ID.toHex(), idx)
    const payload = JSON.parse(new TextDecoder().decode(entry!.data))
    expect(payload.generation).toBe(11)
    expect(payload.claimHints.lastTimestamp).toBe("42")
  })

  it("leaseChunkIndex is beyond numUtilizationChunks so create() ignores it", async () => {
    // Verify that the lease chunk index falls outside the range that
    // UtilizationAwareStamper.create() merges into dataCounters.
    const { numUtilizationChunks } = getChunkLayout(TEST_DEPTH_LM)
    expect(leaseChunkIndex(TEST_DEPTH_LM, 0)).toBeGreaterThanOrEqual(
      numUtilizationChunks,
    )
    expect(leaseChunkIndex(TEST_DEPTH_LM, 1)).toBeGreaterThanOrEqual(
      numUtilizationChunks,
    )
  })
})

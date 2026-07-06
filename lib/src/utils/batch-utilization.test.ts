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
  dataSlot,
  partitionCapacity,
  deriveUtilizationChunkKey,
  deserializeUint16Array,
  deserializeUint32Array,
  extractChunk,
  getChunkIndexForBucket,
  getChunkLayout,
  hasBucketCapacity,
  updateAfterWrite,
  calculateUtilization,
  initializeBatchUtilization,
  LEASE_SKEW_MARGIN_MS,
  LEASE_TTL_MS,
  mergeChunk,
  serializeUint16Array,
  serializeUint32Array,
} from "./batch-utilization"
import { EthAddress, PrivateKey } from "@ethersphere/bee-js"
import type { Chunk as CafeChunk } from "cafe-utility"
import type {
  BatchMetadata,
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

    // 20 × 2 = 40 stamps; ECDSA signing dominates wall time in this test (the
    // bee-js Stamper signs every envelope). The global testTimeout (vitest
    // config) absorbs the parallel-suite CPU contention that used to flake it.
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

  it("a locally-lapsed lease fences the next partition-bound stamp (skew margin applied)", async () => {
    // Race B (Postage-Batch-Partitioning.md §12): a holder whose refresh tick
    // can't renew must stop writing when its OWN clock says the lease lapsed —
    // otherwise a mid-op chunk lands in a slot a peer legitimately took over.
    // Local, no-network fence: `stamp()` throws once `Date.now()` is within the
    // skew margin of `leaseValidUntil`, matching the ack guard's bound.
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

    // Valid until only 500ms out — inside the (2s) skew margin, so the lease is
    // treated as lapsed NOW even though raw expiry hasn't strictly passed.
    stamper.setLeaseValidUntil(Date.now() + 500)

    expect(() => stamper.stamp(makeChunkInBucket(0xa1, 0))).toThrow(
      PartitionLeaseLostError,
    )
  })

  it("a healthy (well-in-future) lease deadline does not fence stamping", async () => {
    // No false positives on the hot path: a freshly-renewed lease (~TTL out)
    // stamps normally. Only an un-renewable, locally-lapsed lease is fenced.
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

    stamper.setLeaseValidUntil(Date.now() + LEASE_TTL_MS)

    expect(() => stamper.stamp(makeChunkInBucket(0xa2, 0))).not.toThrow()
  })

  it("bindPartition clears a stale lease deadline (re-acquire reuses stamper)", async () => {
    // A reused stamper must not carry a previous session's lapsed deadline into
    // a fresh bind — the coordinator pushes the new `leasedUntil` right after.
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
    stamper.setLeaseValidUntil(Date.now() - 1) // already lapsed
    expect(() => stamper.stamp(makeChunkInBucket(0xa3, 0))).toThrow(
      PartitionLeaseLostError,
    )

    // Re-bind → deadline cleared (undefined) → stamps work until the coordinator
    // pushes a fresh one.
    stamper.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    expect(() => stamper.stamp(makeChunkInBucket(0xa3, 1))).not.toThrow()
  })

  it("the lease fence reads the injected clock (deterministic, no Date.now)", async () => {
    // #385: the fence uses the stamper's injected clock — the SAME clock a test
    // gives the lease (whose `leasedUntil` feeds `leaseValidUntil`). Drive it by
    // hand: no real time, no `Date.now` mock; advancing the clock across the
    // deadline flips the fence deterministically.
    let clock = 1_000_000
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
      () => clock,
    )
    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    // Lease valid until clock + 10s. Well clear of the skew margin → no fence.
    stamper.setLeaseValidUntil(clock + 10_000)
    expect(() => stamper.stamp(makeChunkInBucket(0xa4, 0))).not.toThrow()

    // Advance to exactly the skew margin before expiry → now fenced.
    clock = clock + 10_000 - LEASE_SKEW_MARGIN_MS
    expect(() => stamper.stamp(makeChunkInBucket(0xa4, 1))).toThrow(
      PartitionLeaseLostError,
    )
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

  it("intent SOC routes to the contended partition's reserved slot, never a data lane, without consuming data budget", async () => {
    // Phase-2 intent SOCs (partition-intent.ts) are stamped BEFORE the partition
    // is bound. They must overstamp the contended partition's reserved slot
    // (< DATA_COUNTER_START), so they can never collide with user data.
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    // Bind to partition 0 to prove the intent slot comes from the EXPLICIT
    // reservation (the contended partition, here 1), not `this.partition`.
    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })

    const BUCKET = 0x2222
    const CONTENDED = 1
    const intentChunk = makeChunkInBucket(BUCKET, 1)
    stamper.reserveIntentSocSlot(intentChunk.hash(), CONTENDED)
    const intentEnv = decodeIndex(stamper.stamp(intentChunk).index)
    stamper.clearIntentSocSlot()

    expect(intentEnv.bucket).toBe(BUCKET)
    // Routed to the contended partition's reserved slot — below every data lane.
    expect(intentEnv.slot).toBe(CONTENDED)
    expect(intentEnv.slot).toBeLessThan(DATA_COUNTER_START)
    // Did not consume the data lane: counter untouched, so the next data chunk
    // in this bucket still lands at j=0.
    expect(stamper.getLocalCounter()![BUCKET]).toBe(0)
    const dataEnv = decodeIndex(
      stamper.stamp(makeChunkInBucket(BUCKET, 2)).index,
    )
    expect(dataEnv.slot).toBe(dataSlot(0, 0, PARTITION_COUNT))
    expect(dataEnv.slot).toBeGreaterThanOrEqual(DATA_COUNTER_START)
  })

  it("intent stamps never share a (bucket, slot) with data stamps", async () => {
    // Regression guard for the class of bug where intents fell into a data
    // lane (overstamping user data). Interleave data + intent stamps in one
    // bucket and assert the two occupy disjoint slot ranges: data lives at
    // >= DATA_COUNTER_START, intents at the contended partition's reserved
    // slot (< DATA_COUNTER_START). (Intents overstamping each OTHER at the
    // same reserved slot is the documented, accepted residual — not asserted.)
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

    const BUCKET = 0x3333
    const dataSlots = new Set<number>()
    for (let i = 0; i < 10; i++) {
      const dataEnv = decodeIndex(
        stamper.stamp(makeChunkInBucket(BUCKET, 100 + i)).index,
      )
      expect(dataEnv.slot).toBeGreaterThanOrEqual(DATA_COUNTER_START)
      expect(dataSlots.has(dataEnv.slot)).toBe(false) // data slots never reused
      dataSlots.add(dataEnv.slot)

      const intentChunk = makeChunkInBucket(BUCKET, 200 + i)
      stamper.reserveIntentSocSlot(intentChunk.hash(), 0)
      const intentEnv = decodeIndex(stamper.stamp(intentChunk).index)
      stamper.clearIntentSocSlot()
      // Intent slot is below the data range, so it can never equal a data slot.
      expect(intentEnv.slot).toBeLessThan(DATA_COUNTER_START)
      expect(dataSlots.has(intentEnv.slot)).toBe(false)
    }
  })

  it("withIntentSocSlot serializes concurrent intent-SOC writes so neither clobbers the other's reserved slot", async () => {
    // The intent / occupancy / state-pointer SOC writes all share the single
    // `intentSoc` reservation. The off-lock refresh-tick presence beacon and an
    // under-lock upload's state-pointer publish run concurrently, so their
    // reserve→stamp windows can overlap: the second reserve clobbers the first's
    // address, and the first `stamp()` then no longer matches `intentSoc` and
    // falls through to a DATA slot (consuming budget + bumping the counter).
    // `withIntentSocSlot` serializes the critical sections so each writer's
    // reservation is intact at stamp time.
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

    const SLOT = 0
    const slots: Record<string, number> = {}
    async function write(name: string, bucket: number): Promise<void> {
      const chunk = makeChunkInBucket(bucket, bucket)
      await stamper.withIntentSocSlot(chunk.hash(), SLOT, async () => {
        // Yield microtasks so an unserialized concurrent writer would clobber
        // the shared reservation before this flow stamps.
        await Promise.resolve()
        await Promise.resolve()
        slots[name] = decodeIndex(stamper.stamp(chunk).index).slot
      })
    }

    const counterBefore = stamper.getLocalCounter()!.slice()
    await Promise.all([write("A", 0x4444), write("B", 0x5555)])

    // Each SOC routed to the reserved slot (below the data lanes) — proof its
    // reservation survived the other concurrent flow.
    expect(slots.A).toBe(SLOT)
    expect(slots.B).toBe(SLOT)
    expect(slots.A).toBeLessThan(DATA_COUNTER_START)
    // No fall-through to a data slot: the counter is untouched.
    expect(stamper.getLocalCounter()).toEqual(counterBefore)
  })

  it("withIntentSocSlot releases the mutex when fn throws, so later writes don't deadlock", async () => {
    // Regression (the reserve/fn-throw guard): if `fn` — the upload — throws,
    // the `finally` must still `clearIntentSocSlot()` and resolve the lock.
    // Otherwise `intentSocLock` stays pending forever and EVERY later intent /
    // occupancy / state-pointer write on this stamper deadlocks on
    // `await previous`.
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

    const SLOT = 0
    const boom = new Error("upload failed")
    await expect(
      stamper.withIntentSocSlot(new Uint8Array(32), SLOT, async () => {
        throw boom
      }),
    ).rejects.toBe(boom)

    // The mutex must have been released by the failed call: the next write
    // completes and routes to the reserved slot. Without the finally-release it
    // would hang forever on `await previous` (the test would time out).
    const chunk = makeChunkInBucket(0x4444, 0x4444)
    const slot = await stamper.withIntentSocSlot(
      chunk.hash(),
      SLOT,
      async () => decodeIndex(stamper.stamp(chunk).index).slot,
    )
    expect(slot).toBe(SLOT)
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
    // Simulates Case B: device 1 acquires partition 1 and resumes from a
    // non-zero per-bucket high-water published by a previous holder.
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

  it("routes a marked reserved chunk to its EXPLICIT slot even when unbound", async () => {
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    // No bindPartition: this is the teardown-release scenario — the
    // coordinator unbinds synchronously and the detached release publishes
    // afterwards. The slot recorded at marking time must win; falling back
    // to `partition ?? 0` would overstamp partition 0's reserved chunks.
    const BUCKET = 0x1234
    const chunk = makeChunkInBucket(BUCKET, 7)
    stamper.markReservedUtilizationChunk(chunk.hash(), 1)

    const env = decodeIndex(stamper.stamp(chunk).index)
    expect(env.bucket).toBe(BUCKET)
    expect(env.slot).toBe(1)
  })

  it("defaults a marked reserved chunk to the bound partition's slot", async () => {
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
    const BUCKET = 0x4321
    const chunk = makeChunkInBucket(BUCKET, 9)
    stamper.markReservedUtilizationChunk(chunk.hash())

    const env = decodeIndex(stamper.stamp(chunk).index)
    expect(env.slot).toBe(1)
  })
})

describe("UtilizationAwareStamper synced reference", () => {
  const TEST_SIGNER_KEY_LM = new PrivateKey(
    new Uint8Array(32).map((_, i) => (i + 7) & 0xff),
  ).toHex()
  const TEST_OWNER_LM = new EthAddress("11".repeat(20))
  const TEST_ENC_KEY_LM = new Uint8Array(32).fill(0x42)
  const TEST_DEPTH_LM = 24

  function makeRecordingCache(): UtilizationStoreDB {
    const store = new Map<string, ChunkCacheEntry>()
    const metaStore = new Map<string, BatchMetadata>()
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
      getMetadata: async (batchId: string) => metaStore.get(batchId),
      putMetadata: async (metadata: BatchMetadata) => {
        metaStore.set(metadata.batchId, { ...metadata })
      },
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

  it("getSyncedReference round-trips through setSyncedReference (per partition, merge-preserving)", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)

    expect(await stamper.getSyncedReference(0)).toBeUndefined()

    await stamper.setSyncedReference(0, "ref-zero")
    await stamper.setSyncedReference(1, "ref-one")
    expect(await stamper.getSyncedReference(0)).toBe("ref-zero")
    expect(await stamper.getSyncedReference(1)).toBe("ref-one")

    // Overwriting one partition preserves the other.
    await stamper.setSyncedReference(0, "ref-zero-v2")
    expect(await stamper.getSyncedReference(0)).toBe("ref-zero-v2")
    expect(await stamper.getSyncedReference(1)).toBe("ref-one")
  })

  it("persists protected state buckets and restores them on create", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    stamper.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })

    await stamper.setProtectedStateBuckets(1, [7, 99, 1234])
    const protectedNow = stamper.getProtectedBuckets()
    expect(protectedNow.has(7)).toBe(true)
    expect(protectedNow.has(99)).toBe(true)
    expect(protectedNow.has(1234)).toBe(true)
    // Lock-SOC buckets stay included.
    for (const bucket of stamper.getLockSocBuckets()) {
      expect(protectedNow.has(bucket)).toBe(true)
    }

    // A reload (fresh stamper over the same cache) keeps avoiding them.
    const reloaded = await makeStamper(cache)
    reloaded.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    expect(reloaded.getProtectedBuckets().has(1234)).toBe(true)
  })

  it("scopes protection to the bound partition and survives setSyncedReference", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    await stamper.setProtectedStateBuckets(0, [11])
    await stamper.setProtectedStateBuckets(1, [22])
    // Persisting a synced reference must not drop the protected buckets
    // (both live in the same metadata record).
    await stamper.setSyncedReference(0, "ref-zero")

    const reloaded = await makeStamper(cache)
    reloaded.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    expect(reloaded.getProtectedBuckets().has(11)).toBe(true)
    // Partition 1's set does not leak into partition 0's saves.
    expect(reloaded.getProtectedBuckets().has(22)).toBe(false)
    expect(await reloaded.getSyncedReference(0)).toBe("ref-zero")
  })
})

describe("hasBucketCapacity (partition-aware, #416)", () => {
  // dataCounters hold the per-partition `j`, so capacity is the partition's
  // lane (partitionCapacity), NOT the raw slots-per-bucket.
  const DEPTH = 24 // 2^(24-16)=256 slots/bucket → partitionCapacity(2)=127

  it("is full when j reaches the partition capacity, not the raw slot count", () => {
    const cap = partitionCapacity(DEPTH, PARTITION_COUNT)
    expect(hasBucketCapacity(cap - 1, DEPTH, PARTITION_COUNT)).toBe(true)
    // j === cap means the lane is full — the bug let this through (127 < 256).
    expect(hasBucketCapacity(cap, DEPTH, PARTITION_COUNT)).toBe(false)
  })

  it("defaults to PARTITION_COUNT so callers get the partitioned capacity", () => {
    const cap = partitionCapacity(DEPTH, PARTITION_COUNT)
    expect(hasBucketCapacity(cap, DEPTH)).toBe(false)
  })

  it("K=1 uses the full lane (raw slots minus the reserved slot)", () => {
    const cap = partitionCapacity(DEPTH, 1)
    expect(hasBucketCapacity(cap - 1, DEPTH, 1)).toBe(true)
    expect(hasBucketCapacity(cap, DEPTH, 1)).toBe(false)
  })
})

describe("updateAfterWrite capacity guard (#416)", () => {
  const cache = {
    getAllChunks: async () => [],
    putChunk: async () => undefined,
  } as unknown as UtilizationStoreDB

  it("throws 'Bucket is full' at the partition capacity, before bee-js would", async () => {
    const DEPTH = 20 // 2^(20-16)=16 slots/bucket → partitionCapacity(2)=7
    const cap = partitionCapacity(DEPTH, PARTITION_COUNT)
    const BUCKET = 0x1234
    // Distinct content-addressed chunks that all hash into the same bucket.
    const chunks = Array.from({ length: cap + 1 }, (_, i) => {
      const c = makeChunkInBucket(BUCKET, i)
      return {
        address: { toUint8Array: () => c.hash() },
      } as unknown as Parameters<typeof updateAfterWrite>[1][number]
    })
    await expect(
      updateAfterWrite(TEST_BATCH_ID, chunks, DEPTH, { cache }),
    ).rejects.toThrow(/is full/)
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { makeEncryptedContentAddressedChunk } from "../chunk"
import {
  BUCKETS_PER_CHUNK,
  CHUNK_SIZE,
  DATA_COUNTER_START,
  NUM_BUCKETS,
  NUM_UTILIZATION_CHUNKS,
  PARTITION_COUNT,
  PartitionLeaseLostError,
  UtilizationAwareStamper,
  dataSlot,
  partitionCapacity,
  deriveUtilizationChunkKey,
  deserializeUint32Array,
  extractChunk,
  getChunkIndexForBucket,
  hasBucketCapacity,
  updateAfterWrite,
  calculateUtilization,
  initializeBatchUtilization,
  LEASE_SKEW_MARGIN_MS,
  LEASE_TTL_MS,
  MIN_USABLE_BATCH_DEPTH,
  MIN_USABLE_PARTITION_CAPACITY,
  mergeChunk,
  serializeUint32Array,
} from "./batch-utilization"
import { EthAddress, PrivateKey } from "@ethersphere/bee-js"
import {
  UtilizationStoreUnavailableError,
  type BatchMetadata,
  type ChunkCacheEntry,
  type UtilizationStoreDB,
} from "../storage/utilization-store"
import { memoryUtilizationStore } from "../storage/memory-utilization-store"
import { lockSocAddress } from "./lock-soc"
import { deriveSecret, BACKUP_KEY_LABEL } from "./key-derivation"
import { uint8ArrayToHex } from "./hex"

const TEST_BATCH_ID = new BatchId("00".repeat(32))

/**
 * A chunk address landing in `bucket`. bee-js 13's `Stamper.stamp` takes the
 * address alone, so that is all a stamp test needs to build.
 */
function makeAddressInBucket(bucket: number, indexSeed: number): Uint8Array {
  const address = new Uint8Array(32)
  address[0] = (bucket >> 8) & 0xff
  address[1] = bucket & 0xff
  for (let i = 2; i < 32; i++) {
    address[i] = ((indexSeed + 1) * (i + 1)) & 0xff
  }
  return address
}

describe("extractChunk / mergeChunk (fixed uint32 cache layout)", () => {
  it("round-trips a full dataCounters through every chunk", () => {
    const source = new Uint32Array(NUM_BUCKETS)
    for (let i = 0; i < source.length; i++) {
      source[i] = (i * 1664525 + 1013904223) >>> 0
    }

    const target = new Uint32Array(NUM_BUCKETS)
    for (let i = 0; i < NUM_UTILIZATION_CHUNKS; i++) {
      const chunk = extractChunk(source, i)
      expect(chunk.byteLength).toBe(CHUNK_SIZE)
      mergeChunk(target, i, chunk)
    }

    expect(Array.from(target)).toEqual(Array.from(source))
  })

  it("covers all buckets with 64 chunks of 1,024, whatever the depth", () => {
    expect(BUCKETS_PER_CHUNK).toBe(1024)
    expect(NUM_UTILIZATION_CHUNKS).toBe(64)
    expect(BUCKETS_PER_CHUNK * NUM_UTILIZATION_CHUNKS).toBe(NUM_BUCKETS)
  })

  it("rejects an out-of-range chunk index", () => {
    const counters = new Uint32Array(NUM_BUCKETS)
    expect(() => extractChunk(counters, 64)).toThrow(/Invalid chunk index/)
  })

  it("rejects a chunk whose byte length is not CHUNK_SIZE", () => {
    const counters = new Uint32Array(NUM_BUCKETS)
    expect(() => mergeChunk(counters, 0, new Uint8Array(100))).toThrow(
      /Invalid chunk data length/,
    )
  })
})

describe("initializeBatchUtilization", () => {
  it("seeds the per-partition counter at 0 with the fixed chunk count at any depth", () => {
    for (const depth of [24, 32]) {
      const state = initializeBatchUtilization(TEST_BATCH_ID, depth)
      expect(state.batchDepth).toBe(depth)
      expect(state.dataCounters.length).toBe(NUM_BUCKETS)
      // Counter is the 0-based per-partition `j`; reserved headroom lives in
      // the slot formula (`dataSlot`), not in the counter.
      expect(state.dataCounters[0]).toBe(0)
      expect(state.dataCounters[NUM_BUCKETS - 1]).toBe(0)
      expect(state.chunks.length).toBe(NUM_UTILIZATION_CHUNKS)
    }
  })
})

describe("getChunkIndexForBucket (fixed layout)", () => {
  it("maps buckets to 1,024-bucket chunks", () => {
    expect(getChunkIndexForBucket(0)).toBe(0)
    expect(getChunkIndexForBucket(1023)).toBe(0)
    expect(getChunkIndexForBucket(1024)).toBe(1)
    expect(getChunkIndexForBucket(NUM_BUCKETS - 1)).toBe(63)
  })

  it("rejects an out-of-range bucket index", () => {
    expect(() => getChunkIndexForBucket(-1)).toThrow(/Invalid bucket index/)
    expect(() => getChunkIndexForBucket(NUM_BUCKETS)).toThrow(
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
  })
})

describe("MIN_USABLE_BATCH_DEPTH (#538, #566)", () => {
  it("is the smallest depth whose partition lane is worth buying", () => {
    expect(
      partitionCapacity(MIN_USABLE_BATCH_DEPTH, PARTITION_COUNT),
    ).toBeGreaterThanOrEqual(MIN_USABLE_PARTITION_CAPACITY)
    expect(
      partitionCapacity(MIN_USABLE_BATCH_DEPTH - 1, PARTITION_COUNT),
    ).toBeLessThan(MIN_USABLE_PARTITION_CAPACITY)
  })

  it("rules out 17 (no data slot), 18 (exactly one) and 19 (three: ~1 MB before a bucket fills)", () => {
    expect(partitionCapacity(17, PARTITION_COUNT)).toBe(0)
    expect(partitionCapacity(18, PARTITION_COUNT)).toBe(1)
    expect(partitionCapacity(19, PARTITION_COUNT)).toBe(3)
    expect(MIN_USABLE_BATCH_DEPTH).toBe(20)
  })

  it("leaves a bucket with room once its first data chunk lands", () => {
    const state = initializeBatchUtilization(
      TEST_BATCH_ID,
      MIN_USABLE_BATCH_DEPTH,
    )
    state.dataCounters[0] = 1
    expect(calculateUtilization(state, MIN_USABLE_BATCH_DEPTH)).toBeLessThan(1)
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
      const chunk0 = makeAddressInBucket(BUCKET, i * 2)
      const chunk1 = makeAddressInBucket(BUCKET, i * 2 + 1)
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
      stamper.stamp(makeAddressInBucket(BUCKET, j))
    }
    // One more DATA chunk in BUCKET overflows the partition's lane.
    expect(() => stamper.stamp(makeAddressInBucket(BUCKET, 9000))).toThrow(
      "Bucket is full",
    )

    // A counter chunk marked reserved overstamps slot 0 (the partition's
    // reserved slot), which is free even though the data lane is full.
    const counterChunk = makeAddressInBucket(BUCKET, 9999)
    stamper.markReservedUtilizationChunk(counterChunk)
    const env = decodeIndex(stamper.stamp(counterChunk).index)
    expect(env.bucket).toBe(BUCKET)
    expect(env.slot).toBe(0)
  })

  // A scratch drive (#862): the lane is a ring. Past its capacity the next
  // stamp lands on the lane's oldest slot, and the counter keeps counting.
  it("wraps a scratch drive's full lane onto its oldest slot, the counter still rising", async () => {
    const DEPTH = 20
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
      undefined,
      { scratch: true },
    )
    const PARTITION = 1
    stamper.bindPartition({
      partition: PARTITION,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })

    const BUCKET = 0x1234
    const cap = partitionCapacity(DEPTH, PARTITION_COUNT)
    const slots: number[] = []
    for (let j = 0; j < 2 * cap + 1; j++) {
      slots.push(
        decodeIndex(stamper.stamp(makeAddressInBucket(BUCKET, j)).index).slot,
      )
    }

    const lane = Array.from({ length: cap }, (_, j) =>
      dataSlot(PARTITION, j, PARTITION_COUNT),
    )
    expect(slots).toEqual([...lane, ...lane, lane[0]])
    expect(stamper.getLocalCounter()![BUCKET]).toBe(2 * cap + 1)
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
    const envA = decodeIndex(a.stamp(makeAddressInBucket(BUCKET, 0)).index)
    const envB = decodeIndex(b.stamp(makeAddressInBucket(BUCKET, 1)).index)
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
    const env = decodeIndex(stamper.stamp(makeAddressInBucket(0x77, 0)).index)
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
    stamper.stamp(makeAddressInBucket(0x88, 0))

    stamper.invalidateLease()

    // Now any partition-bound stamp aborts — closing the window where an
    // in-flight upload would otherwise silently corrupt a peer's slot.
    expect(() => stamper.stamp(makeAddressInBucket(0x88, 1))).toThrow(
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
    expect(() => stamper.stamp(makeAddressInBucket(0x99, 0))).toThrow(
      PartitionLeaseLostError,
    )

    // After re-binding (e.g. wait-for-slot retry succeeded), stamps work again.
    stamper.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    expect(() => stamper.stamp(makeAddressInBucket(0x99, 1))).not.toThrow()
  })

  it("an invalidated lease still fences data stamps after unbindPartition", async () => {
    // The teardown ordering: invalidate, then unbind, off the write lock — so
    // a stamp of an in-flight upload can follow. Unfenced it would land at the
    // legacy `dataSlot(0, j, 1)` = 1 + j: partition 1's reserved slot and lane.
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
    stamper.unbindPartition()

    expect(() => stamper.stamp(makeAddressInBucket(0x9a, 0))).toThrow(
      PartitionLeaseLostError,
    )
    expect(() => stamper.stamp(makeAddressInBucket(0x9a, 1))).toThrow(
      PartitionLeaseLostError,
    )

    // The next bind is a fresh lease.
    stamper.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    const env = decodeIndex(stamper.stamp(makeAddressInBucket(0x9a, 2)).index)
    expect(env.slot).toBe(dataSlot(1, 0, PARTITION_COUNT))
  })

  it("reserved-slot stamps still work on an invalidated, unbound stamper", async () => {
    // The teardown release publishes the partition state, and writes the lock
    // SOC sentinel, through exactly this stamper.
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    const lockSoc = makeAddressInBucket(0x9b, 0)
    stamper.bindLockSocs([{ partition: 1, address: lockSoc }])
    stamper.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    stamper.invalidateLease()
    stamper.unbindPartition()

    const stateChunk = makeAddressInBucket(0x9b, 1)
    stamper.markReservedUtilizationChunk(stateChunk, 1)
    expect(decodeIndex(stamper.stamp(stateChunk).index).slot).toBe(1)

    expect(decodeIndex(stamper.stamp(lockSoc).index).slot).toBe(1)

    const pointerSoc = makeAddressInBucket(0x9b, 2)
    stamper.reserveIntentSocSlot(pointerSoc, 1)
    expect(decodeIndex(stamper.stamp(pointerSoc).index).slot).toBe(1)
  })

  it("invalidateLease on a never-bound stamper leaves legacy stamping alone", async () => {
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )

    stamper.invalidateLease()

    const env = decodeIndex(stamper.stamp(makeAddressInBucket(0x9c, 0)).index)
    expect(env.slot).toBe(dataSlot(0, 0, 1))
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

    expect(() => stamper.stamp(makeAddressInBucket(0xa1, 0))).toThrow(
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

    expect(() => stamper.stamp(makeAddressInBucket(0xa2, 0))).not.toThrow()
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
    expect(() => stamper.stamp(makeAddressInBucket(0xa3, 0))).toThrow(
      PartitionLeaseLostError,
    )

    // Re-bind → deadline cleared (undefined) → stamps work until the coordinator
    // pushes a fresh one.
    stamper.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    expect(() => stamper.stamp(makeAddressInBucket(0xa3, 1))).not.toThrow()
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
    expect(() => stamper.stamp(makeAddressInBucket(0xa4, 0))).not.toThrow()

    // Advance to exactly the skew margin before expiry → now fenced.
    clock = clock + 10_000 - LEASE_SKEW_MARGIN_MS
    expect(() => stamper.stamp(makeAddressInBucket(0xa4, 1))).toThrow(
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
      const env = decodeIndex(stamper.stamp(lockAddr0).index)
      expect(env.bucket).toBe(0xabcd)
      expect(env.slot).toBe(0)
    }

    // Partition-1 lock SOC always lands at slot 1.
    const env1 = decodeIndex(stamper.stamp(lockAddr1).index)
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
      stamper.stamp(lockAddr)
    }

    // Now a data chunk in the same bucket: must NOT collide with the lock
    // SOC's reserved slot 0; slot must be ≥ DATA_COUNTER_START.
    const env = decodeIndex(stamper.stamp(makeAddressInBucket(BUCKET, 1)).index)
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
    const chunk = makeAddressInBucket(BUCKET, 3)
    stamper.markReservedUtilizationChunk(chunk)

    const env = decodeIndex(stamper.stamp(chunk).index)
    expect(env.bucket).toBe(BUCKET)
    // Reserved slot = partition index, not a data slot; counter untouched.
    expect(env.slot).toBe(1)
    expect(stamper.getLocalCounter()![BUCKET]).toBe(0)

    // After clearing, the same bucket's data chunk uses the data lane again.
    stamper.clearReservedUtilizationChunks()
    const env2 = decodeIndex(
      stamper.stamp(makeAddressInBucket(BUCKET, 4)).index,
    )
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
    const intentChunk = makeAddressInBucket(BUCKET, 1)
    stamper.reserveIntentSocSlot(intentChunk, CONTENDED)
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
      stamper.stamp(makeAddressInBucket(BUCKET, 2)).index,
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
        stamper.stamp(makeAddressInBucket(BUCKET, 100 + i)).index,
      )
      expect(dataEnv.slot).toBeGreaterThanOrEqual(DATA_COUNTER_START)
      expect(dataSlots.has(dataEnv.slot)).toBe(false) // data slots never reused
      dataSlots.add(dataEnv.slot)

      const intentChunk = makeAddressInBucket(BUCKET, 200 + i)
      stamper.reserveIntentSocSlot(intentChunk, 0)
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
      const chunk = makeAddressInBucket(bucket, bucket)
      await stamper.withIntentSocSlot(chunk, SLOT, async () => {
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
    const chunk = makeAddressInBucket(0x4444, 0x4444)
    const slot = await stamper.withIntentSocSlot(
      chunk,
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
    const backupKeyHex = await deriveSecret(
      swarmEncryptionKeyHex,
      BACKUP_KEY_LABEL,
    )
    const backupOwner = new PrivateKey(backupKeyHex).publicKey().address()
    const expectedLockSocAddr = lockSocAddress(TEST_BATCH_ID, 0, backupOwner)

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

    const lockSocChunk = expectedLockSocAddr

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

    const env = decodeIndex(stamper.stamp(makeAddressInBucket(BUCKET, 0)).index)
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
    const chunk = makeAddressInBucket(BUCKET, 7)
    stamper.markReservedUtilizationChunk(chunk, 1)

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
    const chunk = makeAddressInBucket(BUCKET, 9)
    stamper.markReservedUtilizationChunk(chunk)

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
    return memoryUtilizationStore()
  }

  /**
   * A store whose every call lands a macrotask later, so two writers in
   * flight interleave the way two IndexedDB transactions can. Its patch is
   * still atomic: read and write in one tick, as the real store's one
   * `readwrite` transaction is.
   */
  function makeYieldingCache(): UtilizationStoreDB {
    const later = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    let meta: BatchMetadata | undefined
    return {
      getAllChunks: async () => [],
      putChunk: async () => undefined,
      getMetadata: async () => {
        await later()
        return meta
      },
      updateMetadata: async (
        batchId: string,
        patch: (existing: BatchMetadata | undefined) => Partial<BatchMetadata>,
      ) => {
        await later()
        meta = { ...meta, ...patch(meta), batchId }
      },
      writeRows: async (
        batchId: string,
        _entries: ChunkCacheEntry[],
        patch: (existing: BatchMetadata | undefined) => Partial<BatchMetadata>,
      ) => {
        await later()
        meta = { ...meta, ...patch(meta), batchId }
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

  function bind(stamper: UtilizationAwareStamper, partition: number): void {
    stamper.bindPartition({
      partition,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
  }

  // A reference certifies rows as "at or past the counter it names". Only
  // rows that hold exactly that counter may seed an incremental publish: the
  // lease diffs against them, and a leaf it retains must be the leaf the
  // reference chunk describes.
  it("certifies rows as exact only while they hold the counter the reference names", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    bind(stamper, 0)
    stamper.stamp(makeAddressInBucket(7, 1))
    await stamper.setSyncedReference(0, "published")
    await stamper.flush()
    expect(await stamper.getRowsCertification(0)).toEqual({
      referenceHex: "published",
      exact: true,
    })

    // An upload whose publish failed: its stamps reach the rows, no reference
    // names them
    stamper.stamp(makeAddressInBucket(7, 2))
    await stamper.flush()
    expect(await stamper.getRowsCertification(0)).toEqual({
      referenceHex: "published",
      exact: false,
    })

    // The next publish names the rows again
    await stamper.setSyncedReference(0, "republished")
    await stamper.flush()
    expect(await stamper.getRowsCertification(0)).toEqual({
      referenceHex: "republished",
      exact: true,
    })
  })

  it("a reference recorded before later stamps is committed as inexact", async () => {
    // A publish whose flush failed, then an upload whose publish failed: the
    // rows that finally land are past the counter the pending reference names
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    bind(stamper, 0)
    await stamper.setSyncedReference(0, "published")
    stamper.stamp(makeAddressInBucket(7, 1))
    await stamper.flush()
    expect(await stamper.getRowsCertification(0)).toEqual({
      referenceHex: "published",
      exact: false,
    })
  })

  it("rows rewritten for a table no reference names lose the lane's old reference", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    bind(stamper, 0)
    stamper.stamp(makeAddressInBucket(7, 1))
    await stamper.setSyncedReference(0, "ref-zero")
    await stamper.flush()
    bind(stamper, 1)
    await stamper.flush()

    // Back on lane 0 with no state found (its pointer aged out): zero-seeded
    bind(stamper, 0)
    await stamper.flush()
    expect(await stamper.getRowsCertification(0)).toBeUndefined()
    expect(await stamper.getRowsCertification(1)).toBeUndefined()
  })

  // The rows are shared by every tab of the partition, each with its own
  // stamper. What a tab knew of the rows when it opened says nothing about
  // them once another tab has flushed.
  it("a tab whose view of the rows is stale rewrites them all rather than certify a mix of two lanes", async () => {
    const cache = makeRecordingCache()
    const laneZero = new Uint32Array(NUM_BUCKETS)
    laneZero[0x4321] = 9
    const bindTable = (
      stamper: UtilizationAwareStamper,
      partition: number,
      localCounter: Uint32Array,
    ) =>
      stamper.bindPartition({
        partition,
        partitionCount: PARTITION_COUNT,
        localCounter,
      })

    const tabA = await makeStamper(cache)
    bindTable(tabA, 0, laneZero.slice())
    await tabA.setSyncedReference(0, "ref-a")
    await tabA.flush()

    const tabB = await makeStamper(cache) // opened while the rows are lane 0's

    bindTable(tabA, 1, new Uint32Array(NUM_BUCKETS))
    tabA.stamp(makeAddressInBucket(7, 2))
    await tabA.flush()

    // Tab B claims lane 0: the rows are no longer certified for it, so it
    // downloads the lane's (unchanged) state and binds that
    expect(await tabB.getRowsCertification(0)).toBeUndefined()
    bindTable(tabB, 0, laneZero.slice())
    tabB.stamp(makeAddressInBucket(5, 3))
    await tabB.setSyncedReference(0, "ref-b")
    await tabB.flush()

    const cold = await makeStamper(cache)
    expect((await cold.getRowsCertification(0))?.referenceHex).toBe("ref-b")
    const counters = cold.getUtilizationState().dataCounters
    expect(counters[0x4321]).toBe(9)
    expect(counters[5]).toBe(1)
    expect(counters[7]).toBe(0)
  })

  it("a tab resumes a lane from the rows another tab wrote, not from its own older table", async () => {
    const cache = makeRecordingCache()
    const tabA = await makeStamper(cache)
    bind(tabA, 0)
    tabA.stamp(makeAddressInBucket(7, 1))
    await tabA.setSyncedReference(0, "first")
    await tabA.flush()

    const tabB = await makeStamper(cache)

    tabA.stamp(makeAddressInBucket(7, 2))
    await tabA.setSyncedReference(0, "second")
    await tabA.flush()

    // Tab B takes the lane over with no broadcast having reached it
    expect(await tabB.getRowsCertification(0)).toEqual({
      referenceHex: "second",
      exact: true,
    })
    expect(tabB.buildLeaseLocalCounter()[7]).toBe(2)
  })

  it("a flush that fails writes nothing, and the next one lands whole", async () => {
    // Rows and metadata go in one transaction: a tab closed mid-flush leaves
    // neither a row past its reference nor a reference past its rows
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    bind(stamper, 0)
    stamper.stamp(makeAddressInBucket(7, 1))
    await stamper.setSyncedReference(0, "published")
    await stamper.flush()

    stamper.stamp(makeAddressInBucket(7, 2))
    const writeRows = cache.writeRows.bind(cache)
    cache.writeRows = async () => {
      throw new Error("tab closed")
    }
    await expect(stamper.flush()).rejects.toThrow("tab closed")

    const reopened = await makeStamper(cache)
    expect(reopened.getUtilizationState().dataCounters[7]).toBe(1)
    expect(await reopened.getRowsCertification(0)).toEqual({
      referenceHex: "published",
      exact: true,
    })

    // The stamper keeps what it could not write, and writes it next time
    cache.writeRows = writeRows
    await stamper.flush()
    const afterRetry = await makeStamper(cache)
    expect(afterRetry.getUtilizationState().dataCounters[7]).toBe(2)
    expect(await afterRetry.getRowsCertification(0)).toEqual({
      referenceHex: "published",
      exact: false,
    })
  })

  it("a sibling's counters folded in after a reference was recorded make it inexact", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    bind(stamper, 0)
    await stamper.setSyncedReference(0, "read-on-claim")
    stamper.applyUtilizationUpdate([{ index: 9, value: 4 }])
    await stamper.flush()
    expect(await stamper.getRowsCertification(0)).toEqual({
      referenceHex: "read-on-claim",
      exact: false,
    })
  })

  // Counters only grow, so rows another tab wrote are folded in by maximum:
  // neither tab's table may lower the other's.
  it("a tab that missed a sibling's writes folds the rows in at the lock, and stamps past them", async () => {
    const cache = makeRecordingCache()
    const tabA = await makeStamper(cache)
    const tabB = await makeStamper(cache) // legacy lane: neither ever binds
    for (let i = 0; i < 3; i++) tabA.stamp(makeAddressInBucket(7, i))
    await tabA.flush()

    await tabB.syncRows() // what the coordinator does on taking the write lock
    expect(tabB.getUtilizationState().dataCounters[7]).toBe(3)
    tabB.stamp(makeAddressInBucket(7, 9))
    tabB.stamp(makeAddressInBucket(5000, 1))
    await tabB.flush()

    const counters = (await makeStamper(cache)).getUtilizationState()
      .dataCounters
    expect(counters[7]).toBe(4)
    expect(counters[5000]).toBe(1)
  })

  it("a flush never lowers a row another tab wrote, even with no sync before the stamps", async () => {
    const cache = makeRecordingCache()
    const tabA = await makeStamper(cache)
    const tabB = await makeStamper(cache)
    for (let i = 0; i < 3; i++) tabA.stamp(makeAddressInBucket(7, i))
    await tabA.flush()

    tabB.stamp(makeAddressInBucket(5000, 1))
    tabB.stamp(makeAddressInBucket(8, 1)) // same row as bucket 7
    await tabB.flush()

    const counters = (await makeStamper(cache)).getUtilizationState()
      .dataCounters
    expect(counters[7]).toBe(3)
    expect(counters[8]).toBe(1)
    expect(counters[5000]).toBe(1)
  })

  it("a flush refuses to land over rows another tab wrote while it was being prepared, and lands once it has folded them in", async () => {
    // Not reachable under the write lock; the transaction still checks, so a
    // caller outside it cannot lower a row either
    const cache = makeRecordingCache()
    const tabA = await makeStamper(cache)
    const tabB = await makeStamper(cache)
    tabB.stamp(makeAddressInBucket(8, 1))

    const writeRows = cache.writeRows.bind(cache)
    cache.writeRows = async (batchId, entries, patch) => {
      // Tab A's whole flush slips in between tab B's read and its write
      cache.writeRows = writeRows
      for (let i = 0; i < 3; i++) tabA.stamp(makeAddressInBucket(7, i))
      await tabA.flush()
      await writeRows(batchId, entries, patch)
    }
    await expect(tabB.flush()).rejects.toThrow("another tab")
    expect(
      (await makeStamper(cache)).getUtilizationState().dataCounters[8],
    ).toBe(0)

    await tabB.flush()
    const counters = (await makeStamper(cache)).getUtilizationState()
      .dataCounters
    expect(counters[7]).toBe(3)
    expect(counters[8]).toBe(1)
  })

  it("two tabs bound to one lane keep each other's counters, and the certification stays true to the rows", async () => {
    const cache = makeRecordingCache()
    const tabA = await makeStamper(cache)
    bind(tabA, 0)
    await tabA.flush()
    const tabB = await makeStamper(cache)
    bind(tabB, 0)

    for (let i = 0; i < 3; i++) tabA.stamp(makeAddressInBucket(7, i))
    await tabA.setSyncedReference(0, "ref-a")
    await tabA.flush()

    await tabB.syncRows()
    tabB.stamp(makeAddressInBucket(5000, 1))
    await tabB.setSyncedReference(0, "ref-b")
    await tabB.flush()

    const cold = await makeStamper(cache)
    expect(cold.getUtilizationState().dataCounters[7]).toBe(3)
    expect(cold.getUtilizationState().dataCounters[5000]).toBe(1)
    expect(await cold.getRowsCertification(0)).toEqual({
      referenceHex: "ref-b",
      exact: true,
    })
    expect(tabB.getLocalCounter()![7]).toBe(3)
  })

  it("a stamper opened while another tab's flush is in flight still ends up with the rows that flush wrote", async () => {
    const cache = makeRecordingCache()
    const tabA = await makeStamper(cache)
    bind(tabA, 0)
    tabA.stamp(makeAddressInBucket(7, 1))
    await tabA.setSyncedReference(0, "first")
    await tabA.flush()

    tabA.stamp(makeAddressInBucket(7, 2))
    tabA.stamp(makeAddressInBucket(5000, 1))
    await tabA.setSyncedReference(0, "second")
    const writeRows = cache.writeRows.bind(cache)
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => (openGate = resolve))
    let reachedRows!: () => void
    const atRows = new Promise<void>((resolve) => (reachedRows = resolve))
    cache.writeRows = async (batchId, entries, patch) => {
      reachedRows()
      await gate
      await writeRows(batchId, entries, patch)
    }
    const flushing = tabA.flush()
    await atRows
    const tabB = await makeStamper(cache) // reads metadata and rows mid-flush
    openGate()
    await flushing

    expect(await tabB.getRowsCertification(0)).toEqual({
      referenceHex: "second",
      exact: true,
    })
    const table = tabB.buildLeaseLocalCounter()
    expect(table[7]).toBe(2)
    expect(table[5000]).toBe(1)
  })

  it("a legacy stamper opened mid-flush folds the finished rows in at its next lock", async () => {
    const cache = makeRecordingCache()
    const tabA = await makeStamper(cache)
    tabA.stamp(makeAddressInBucket(7, 1))
    tabA.stamp(makeAddressInBucket(5000, 1))
    const writeRows = cache.writeRows.bind(cache)
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => (openGate = resolve))
    let reachedRows!: () => void
    const atRows = new Promise<void>((resolve) => (reachedRows = resolve))
    cache.writeRows = async (batchId, entries, patch) => {
      reachedRows()
      await gate
      await writeRows(batchId, entries, patch)
    }
    const flushing = tabA.flush()
    await atRows
    const tabB = await makeStamper(cache)
    openGate()
    await flushing

    await tabB.syncRows()
    expect(tabB.getUtilizationState().dataCounters[7]).toBe(1)
    expect(tabB.getUtilizationState().dataCounters[5000]).toBe(1)
  })

  it("resumes a lane from the rows even when this stamper's own table was left as another lane's", async () => {
    // A bind whose flush never ran (IndexedDB failed, the lease was lost
    // first): the table in memory is lane 1's, the rows still lane 0's
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    bind(stamper, 0)
    stamper.stamp(makeAddressInBucket(7, 1))
    await stamper.setSyncedReference(0, "ref-zero")
    await stamper.flush()

    bind(stamper, 1)
    stamper.unbindPartition()

    expect(await stamper.getRowsCertification(0)).toEqual({
      referenceHex: "ref-zero",
      exact: true,
    })
    expect(stamper.buildLeaseLocalCounter()[7]).toBe(1)
  })

  it("holds its invariants under any interleaving of two tabs on one lane", async () => {
    // Model: a publish records the counter it names. Whatever the tabs do,
    // rows certified by a reference are at or past its counter, and exactly
    // it when they are called exact; and no row ever goes down.
    let seed = 0x5eed
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const BUCKETS = [7, 8, 5000, 0x4321]
    const ROUNDS = 400
    const cache = makeRecordingCache()
    const published = new Map<string, Uint32Array>()
    const tabs = [await makeStamper(cache), await makeStamper(cache)]
    for (const tab of tabs) {
      await tab.syncRows()
      tab.bindPartition({
        partition: 0,
        partitionCount: PARTITION_COUNT,
        localCounter: tab.buildLeaseLocalCounter(),
      })
      await tab.flush()
    }
    let floor = new Uint32Array(NUM_BUCKETS)
    for (let round = 0; round < ROUNDS; round++) {
      const tab = tabs[random(tabs.length)]
      // One locked section: sync, some stamps, maybe a publish, a flush
      // that may fail
      if (random(4) !== 0) await tab.syncRows()
      for (let i = random(4); i > 0; i--) {
        tab.stamp(makeAddressInBucket(BUCKETS[random(BUCKETS.length)], round))
      }
      if (random(3) !== 0) {
        const referenceHex = `ref-${round}`
        published.set(referenceHex, tab.getLocalCounter()!.slice())
        await tab.setSyncedReference(0, referenceHex)
      }
      const writeRows = cache.writeRows.bind(cache)
      if (random(5) === 0) {
        cache.writeRows = async () => {
          throw new Error("tab closed")
        }
      }
      await tab.flush().catch(() => undefined)
      cache.writeRows = writeRows

      const cold = await makeStamper(cache)
      const rows = cold.getUtilizationState().dataCounters
      for (const bucket of BUCKETS) {
        expect(
          rows[bucket],
          `round ${round} bucket ${bucket}`,
        ).toBeGreaterThanOrEqual(floor[bucket])
      }
      floor = rows.slice()
      const certification = await cold.getRowsCertification(0)
      if (certification !== undefined) {
        const named = published.get(certification.referenceHex)!
        for (const bucket of BUCKETS) {
          if (certification.exact) {
            expect(rows[bucket], `round ${round} exact ${bucket}`).toBe(
              named[bucket],
            )
          } else {
            expect(rows[bucket]).toBeGreaterThanOrEqual(named[bucket])
          }
        }
      }
    }
  })

  // The cache rows hold one lane's counter — `bindPartition` replaces the
  // table — so one synced reference certifies them, not one per partition.
  it("keeps one lane's reference: a publish of another lane replaces it", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    expect(
      (await stamper.getRowsCertification(0))?.referenceHex,
    ).toBeUndefined()

    bind(stamper, 0)
    await stamper.setSyncedReference(0, "ref-zero")
    await stamper.flush()
    expect((await stamper.getRowsCertification(0))?.referenceHex).toBe(
      "ref-zero",
    )

    bind(stamper, 1)
    await stamper.setSyncedReference(1, "ref-one")
    await stamper.flush()
    expect((await stamper.getRowsCertification(1))?.referenceHex).toBe(
      "ref-one",
    )
    expect(
      (await stamper.getRowsCertification(0))?.referenceHex,
    ).toBeUndefined()

    // A cold start sees the same
    const reloaded = await makeStamper(cache)
    expect((await reloaded.getRowsCertification(1))?.referenceHex).toBe(
      "ref-one",
    )
    expect(
      (await reloaded.getRowsCertification(0))?.referenceHex,
    ).toBeUndefined()
  })

  it("certifies a reference only once the rows describe its lane: a publish no flush followed is not a resume point", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    bind(stamper, 0)
    await stamper.setSyncedReference(0, "ref-zero")
    await stamper.flush()
    // Lane switch: the publish lands (ack-after-publish) and the tab dies
    // before the flush that would rewrite the rows for lane 1. The rows still
    // hold lane 0's counter at "ref-zero", so that stays a resume point
    bind(stamper, 1)
    await stamper.setSyncedReference(1, "ref-one")

    const reloaded = await makeStamper(cache)
    expect(
      (await reloaded.getRowsCertification(1))?.referenceHex,
    ).toBeUndefined()
    expect((await reloaded.getRowsCertification(0))?.referenceHex).toBe(
      "ref-zero",
    )
  })

  it("a lane change whose flush fails leaves the rows and their certification as they were", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    bind(stamper, 0)
    stamper.stamp(makeAddressInBucket(7, 1))
    await stamper.setSyncedReference(0, "ref-zero")
    await stamper.flush()

    bind(stamper, 1)
    await stamper.setSyncedReference(1, "ref-one")
    cache.writeRows = async () => {
      throw new Error("tab closed")
    }
    await expect(stamper.flush()).rejects.toThrow("tab closed")

    const reloaded = await makeStamper(cache)
    expect(await reloaded.getRowsCertification(1)).toBeUndefined()
    expect(await reloaded.getRowsCertification(0)).toEqual({
      referenceHex: "ref-zero",
      exact: true,
    })
    expect(reloaded.buildLeaseLocalCounter()[7]).toBe(1)
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
    // (both live in the same metadata record). The reference certifies the
    // rows for lane 0 once a flush has written them for it.
    bind(stamper, 0)
    await stamper.setSyncedReference(0, "ref-zero")
    await stamper.flush()

    const reloaded = await makeStamper(cache)
    reloaded.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    expect(reloaded.getProtectedBuckets().has(11)).toBe(true)
    // Partition 1's set does not leak into partition 0's saves.
    expect(reloaded.getProtectedBuckets().has(22)).toBe(false)
    expect((await reloaded.getRowsCertification(0))?.referenceHex).toBe(
      "ref-zero",
    )
  })

  // Every upload publishes, then acks, then flushes. A reference recorded at
  // the publish would vouch for rows one write behind the counter it names:
  // a tab dying before the flush resumes from them and re-issues that
  // write's slots. So the flush that writes the rows commits the reference.
  it("commits a reference at the flush that writes the rows it describes, never before", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    bind(stamper, 0)
    await stamper.setSyncedReference(0, "ref-a")
    await stamper.flush()
    expect((await stamper.getRowsCertification(0))?.referenceHex).toBe("ref-a")

    // A write and its publish land; the tab dies before the flush
    stamper.stamp(makeAddressInBucket(7, 1))
    await stamper.setSyncedReference(0, "ref-b")
    const died = await makeStamper(cache)
    expect((await died.getRowsCertification(0))?.referenceHex).toBe("ref-a")

    await stamper.flush()
    const reloaded = await makeStamper(cache)
    expect((await reloaded.getRowsCertification(0))?.referenceHex).toBe("ref-b")
    expect(reloaded.getUtilizationState().dataCounters[7]).toBe(1)
  })

  it("commits a publish's reference even when the publish wrote no new slot", async () => {
    // A release or a full re-pin publishes the counter the rows already hold
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    bind(stamper, 0)
    await stamper.flush()
    await stamper.setSyncedReference(0, "ref-a")
    await stamper.flush()
    expect(
      (await (await makeStamper(cache)).getRowsCertification(0))?.referenceHex,
    ).toBe("ref-a")
  })

  it("keeps every field when two metadata writers are in flight at once", async () => {
    const cache = makeYieldingCache()
    const stamper = await makeStamper(cache)
    await Promise.all([
      stamper.setProtectedStateBuckets(0, [11]),
      stamper.setProtectedStateBuckets(1, [22]),
    ])
    expect(
      (await cache.getMetadata(TEST_BATCH_ID.toHex()))?.stateChunkBuckets,
    ).toEqual({ 0: [11], 1: [22] })
  })
})

describe("UtilizationAwareStamper cache rows (#463)", () => {
  const SIGNER = new PrivateKey(
    new Uint8Array(32).map((_, i) => (i + 11) & 0xff),
  ).toHex()
  const OWNER = new EthAddress("33".repeat(20))
  const ENC_KEY = new Uint8Array(32).fill(0x24)

  function makeRecordingCache(seed: ChunkCacheEntry[] = []) {
    return { cache: memoryUtilizationStore(seed) }
  }

  async function create(
    cache: UtilizationStoreDB,
    depth: number,
    scratch = false,
  ): Promise<UtilizationAwareStamper> {
    return UtilizationAwareStamper.create(
      SIGNER,
      TEST_BATCH_ID,
      depth,
      cache,
      OWNER,
      ENC_KEY,
      undefined,
      { scratch },
    )
  }

  it("a lane switch rewrites every row, so a cold start reads the bound lane and never a mix", async () => {
    const { cache } = makeRecordingCache()
    const stamper = await create(cache, 24)
    const laneZero = new Uint32Array(NUM_BUCKETS)
    laneZero[0x4321] = 9
    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: laneZero,
    })
    stamper.stamp(makeAddressInBucket(0x4321, 1))
    await stamper.flush()

    // Lane 1 never touched bucket 0x4321: its row must not keep lane 0's 10
    const laneOne = new Uint32Array(NUM_BUCKETS)
    stamper.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter: laneOne,
    })
    stamper.stamp(makeAddressInBucket(7, 2))
    await stamper.flush()

    const counters = (await create(cache, 24)).getUtilizationState()
      .dataCounters
    expect(counters[7]).toBe(1)
    expect(counters[0x4321]).toBe(0)
    expect(counters).toEqual(stamper.getUtilizationState().dataCounters)
  })

  it("a bind to a counter the rows do not hold rewrites every row, lane switch or not", async () => {
    const { cache } = makeRecordingCache()
    const stamper = await create(cache, 24)
    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    stamper.stamp(makeAddressInBucket(0x4321, 1))
    await stamper.flush()

    // Another device held lane 0 meanwhile and wrote bucket 7 five times; the
    // counter resumed from its publish is ahead of the rows there
    const resumed = stamper.buildLeaseLocalCounter()
    resumed[7] = 5
    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: resumed,
    })
    await stamper.flush()

    const counters = (await create(cache, 24)).getUtilizationState()
      .dataCounters
    expect(counters[7]).toBe(5)
    expect(counters[0x4321]).toBe(1)
  })

  it("a bind to the counter the rows already hold writes nothing", async () => {
    // The adopt fast path and an unchanged resume bind the stamper's own table
    const { cache } = makeRecordingCache()
    const stamper = await create(cache, 24)
    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    stamper.stamp(makeAddressInBucket(0x4321, 1))
    await stamper.flush()

    let writes = 0
    const writeRows = cache.writeRows.bind(cache)
    cache.writeRows = async (batchId, entries, patch) => {
      writes += entries.length
      await writeRows(batchId, entries, patch)
    }
    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: stamper.buildLeaseLocalCounter(),
    })
    await stamper.flush()
    expect(writes).toBe(0)
  })

  it("rows flushed at one depth load unchanged at another: a dilute changes no cached byte", async () => {
    const { cache } = makeRecordingCache()
    const before = await create(cache, 24)
    before.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    const BUCKET = 0x4321
    before.stamp(makeAddressInBucket(BUCKET, 1))
    before.stamp(makeAddressInBucket(BUCKET, 2))
    before.stamp(makeAddressInBucket(NUM_BUCKETS - 1, 3))
    await before.flush()

    const after = await create(cache, 32)
    expect(after.getUtilizationState().dataCounters[BUCKET]).toBe(2)
    expect(after.getUtilizationState().dataCounters[NUM_BUCKETS - 1]).toBe(1)
    expect(after.getUtilizationState().dataCounters).toEqual(
      before.getUtilizationState().dataCounters,
    )
  })

  it("starts fresh when the store itself is unavailable: no rows can exist there", async () => {
    const cache = {
      getAllChunks: async () => {
        throw new UtilizationStoreUnavailableError("IndexedDB disabled")
      },
    } as unknown as UtilizationStoreDB
    const stamper = await create(cache, 24)
    expect(
      stamper.getUtilizationState().dataCounters.every((c) => c === 0),
    ).toBe(true)
  })

  it("refuses to start from zero when the cache cannot be read", async () => {
    // A zero counter over rows that exist would flush zero-based rows over
    // them on the first write and re-issue every slot they record.
    const cache = {
      getAllChunks: async () => {
        throw new Error("IndexedDB blocked")
      },
    } as unknown as UtilizationStoreDB
    await expect(create(cache, 24)).rejects.toThrow("IndexedDB blocked")
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
      const c = makeAddressInBucket(BUCKET, i)
      return {
        address: { toUint8Array: () => c },
      } as unknown as Parameters<typeof updateAfterWrite>[1][number]
    })
    await expect(
      updateAfterWrite(TEST_BATCH_ID, chunks, DEPTH, { cache }),
    ).rejects.toThrow(/is full/)
  })
})

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
  UtilizationAwareStamper,
  dataSlot,
  partitionCapacity,
  deriveUtilizationChunkKey,
  deserializeUint32Array,
  extractChunk,
  getChunkIndexForBucket,
  getChunkLayout,
  hasBucketCapacity,
  updateAfterWrite,
  calculateUtilization,
  initializeBatchUtilization,
  MIN_USABLE_BATCH_DEPTH,
  MIN_USABLE_PARTITION_CAPACITY,
  mergeChunk,
  serializeUint32Array,
} from "./batch-utilization"
import { EthAddress, PrivateKey } from "@ethersphere/bee-js"
import type {
  BatchMetadata,
  ChunkCacheEntry,
  UtilizationStoreDB,
} from "../storage/utilization-store"

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

describe("getChunkLayout", () => {
  it("is 64 rows of 1024 uint32 counters, for every batch", () => {
    const layout = getChunkLayout()
    expect(layout.bucketsPerChunk).toBe(1024)
    expect(layout.numUtilizationChunks).toBe(64)
    expect(layout.bucketsPerChunk * layout.numUtilizationChunks).toBe(
      NUM_BUCKETS,
    )
  })
})

describe("extractChunk / mergeChunk", () => {
  it("round-trips a full dataCounters", () => {
    const { numUtilizationChunks } = getChunkLayout()
    const source = new Uint32Array(NUM_BUCKETS)
    for (let i = 0; i < source.length; i++) {
      source[i] = (i * 1664525 + 1013904223) >>> 0
    }

    const target = new Uint32Array(NUM_BUCKETS)
    for (let i = 0; i < numUtilizationChunks; i++) {
      const chunk = extractChunk(source, i)
      expect(chunk.byteLength).toBe(CHUNK_SIZE)
      mergeChunk(target, i, chunk)
    }

    expect(Array.from(target)).toEqual(Array.from(source))
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
  it("seeds the per-partition counter at 0 and matches the layout's chunk count", () => {
    const state = initializeBatchUtilization(TEST_BATCH_ID, 24)
    expect(state.batchDepth).toBe(24)
    expect(state.dataCounters.length).toBe(NUM_BUCKETS)
    // Counter is the 0-based per-partition `j`; reserved headroom lives in the
    // slot formula (`dataSlot`), not in the counter.
    expect(state.dataCounters[0]).toBe(0)
    expect(state.dataCounters[NUM_BUCKETS - 1]).toBe(0)
    expect(state.chunks.length).toBe(64)
  })
})

describe("getChunkIndexForBucket", () => {
  it("maps buckets to rows of 1024", () => {
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
 * encryption key. These tests pin the underlying property: for a
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
 * The partition-aware stamper is the load-bearing piece of sharing one batch
 * between devices: when two devices stamp into the same shared
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

  /** A cache that keeps what it is given, like the IndexedDB one. */
  function makeMemoryCache(): UtilizationStoreDB {
    const rows = new Map<number, unknown>()
    return {
      getAllChunks: async () => [...rows.values()],
      putChunk: async (row: { chunkIndex: number }) => {
        rows.set(row.chunkIndex, row)
      },
    } as unknown as UtilizationStoreDB
  }

  // #463. A dilute doubles a batch's slots and nothing else: no batch is
  // bought and none is filled, the depth is what is injected.
  describe("a batch diluted from depth 31 to 32", () => {
    const BEFORE = 31
    const AFTER = 32
    const BUCKET = 0x1234

    async function stamperAt(depth: number, cache: UtilizationStoreDB) {
      return UtilizationAwareStamper.create(
        TEST_SIGNER_KEY,
        TEST_BATCH_ID,
        depth,
        cache,
        TEST_OWNER,
        TEST_ENC_KEY,
      )
    }

    /** A lane with one free slot left in BUCKET at the old depth. */
    function nearlyFullLane(): Uint32Array {
      const counter = new Uint32Array(NUM_BUCKETS)
      counter[BUCKET] = partitionCapacity(BEFORE, PARTITION_COUNT) - 1
      return counter
    }

    it("keeps the counters its cache holds", async () => {
      const cache = makeMemoryCache()
      const before = await stamperAt(BEFORE, cache)
      before.bindPartition({
        partition: 0,
        partitionCount: PARTITION_COUNT,
        localCounter: nearlyFullLane(),
      })
      before.stamp(makeAddressInBucket(BUCKET, 1))
      await before.flush()
      const written = before.getUtilizationState().dataCounters[BUCKET]
      expect(written).toBeGreaterThan(0)

      const after = await stamperAt(AFTER, cache)
      expect(after.getUtilizationState().dataCounters[BUCKET]).toBe(written)
    })

    it("stamps on in a lane that was full, without reusing a slot", async () => {
      const before = await stamperAt(BEFORE, makeEmptyCache())
      before.bindPartition({
        partition: 0,
        partitionCount: PARTITION_COUNT,
        localCounter: nearlyFullLane(),
      })
      const last = decodeIndex(
        before.stamp(makeAddressInBucket(BUCKET, 1)).index,
      )
      expect(() => before.stamp(makeAddressInBucket(BUCKET, 2))).toThrow(
        "Bucket is full",
      )

      const after = await stamperAt(AFTER, makeEmptyCache())
      after.bindPartition({
        partition: 0,
        partitionCount: PARTITION_COUNT,
        localCounter: before.getLocalCounter()!,
      })
      const next = decodeIndex(
        after.stamp(makeAddressInBucket(BUCKET, 2)).index,
      )
      expect(next.bucket).toBe(BUCKET)
      expect(next.slot).toBeGreaterThan(last.slot)
    })

    // A peer that has not folded the new depth yet reads a counter past what
    // it thinks the lane holds.
    it("is full, not reset, for a device still on the old depth", async () => {
      const counter = new Uint32Array(NUM_BUCKETS)
      counter[BUCKET] = partitionCapacity(BEFORE, PARTITION_COUNT) + 5
      const stale = await stamperAt(BEFORE, makeEmptyCache())
      stale.bindPartition({
        partition: 0,
        partitionCount: PARTITION_COUNT,
        localCounter: counter,
      })
      expect(() => stale.stamp(makeAddressInBucket(BUCKET, 3))).toThrow(
        "Bucket is full",
      )
    })
  })

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
    stamper.markReservedUtilizationChunk(counterChunk, 0)
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

  it("keeps a scratch drive's wrapped counter, which is past uint16", () => {
    const PAST_UINT16 = 70_000
    const counters = new Uint32Array(NUM_BUCKETS)
    counters[3] = PAST_UINT16
    const restored = new Uint32Array(NUM_BUCKETS)
    mergeChunk(restored, 0, extractChunk(counters, 0))
    expect(restored[3]).toBe(PAST_UINT16)
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
    // the collision partitioning prevents.
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
    // A publish that outlives the lane goes through exactly this stamper.
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
    stamper.invalidateLease()
    stamper.unbindPartition()

    const stateChunk = makeAddressInBucket(0x9b, 1)
    stamper.markReservedUtilizationChunk(stateChunk, 1)
    expect(decodeIndex(stamper.stamp(stateChunk).index).slot).toBe(1)

    const pointerSoc = makeAddressInBucket(0x9b, 2)
    stamper.reserveStatePointerSlot(pointerSoc, 1)
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

  it("a passed deadline fences the next partition-bound stamp", async () => {
    // A holder whose connection went unconfirmed must stop writing when its
    // OWN clock passes the deadline — otherwise a mid-op chunk lands in a
    // slot someone else legitimately took over. Local, no-network fence:
    // `stamp()` throws once `Date.now()` reaches `leaseValidUntil`.
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

    stamper.setLeaseValidUntil(Date.now())

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

    stamper.setLeaseValidUntil(Date.now() + 30_000)

    expect(() => stamper.stamp(makeAddressInBucket(0xa2, 0))).not.toThrow()
  })

  it("bindPartition clears a stale lease deadline (re-acquire reuses stamper)", async () => {
    // A reused stamper must not carry a previous session's lapsed deadline into
    // a fresh bind — the coordinator pushes the new deadline right after.
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
    // #385: the fence uses the stamper's injected clock. Drive it by hand: no
    // real time, no `Date.now` mock; advancing the clock across the deadline
    // flips the fence deterministically.
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
    // May stamp until clock + 10s → no fence yet.
    stamper.setLeaseValidUntil(clock + 10_000)
    expect(() => stamper.stamp(makeAddressInBucket(0xa4, 0))).not.toThrow()

    // Advance to the deadline → now fenced.
    clock = clock + 10_000
    expect(() => stamper.stamp(makeAddressInBucket(0xa4, 1))).toThrow(
      PartitionLeaseLostError,
    )
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
    stamper.markReservedUtilizationChunk(chunk, 1)

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

  it("a state-pointer SOC routes to the reserved slot of the partition it names, never a data lane, without consuming data budget", async () => {
    // A state-pointer SOC (`writeStatePointer`) is stamped at the slot its
    // reservation names: the reserved slot of the partition whose state it
    // points at (< DATA_COUNTER_START), so it can never collide with user data.
    const stamper = await UtilizationAwareStamper.create(
      TEST_SIGNER_KEY,
      TEST_BATCH_ID,
      TEST_DEPTH,
      makeEmptyCache(),
      TEST_OWNER,
      TEST_ENC_KEY,
    )
    // Bind to partition 0 to prove the slot comes from the EXPLICIT
    // reservation (partition 1 here), not `this.partition`.
    stamper.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })

    const BUCKET = 0x2222
    const OTHER_PARTITION = 1
    const pointerChunk = makeAddressInBucket(BUCKET, 1)
    stamper.reserveStatePointerSlot(pointerChunk, OTHER_PARTITION)
    const pointerEnv = decodeIndex(stamper.stamp(pointerChunk).index)
    stamper.clearStatePointerSlot()

    expect(pointerEnv.bucket).toBe(BUCKET)
    // Routed to the named partition's reserved slot — below every data lane.
    expect(pointerEnv.slot).toBe(OTHER_PARTITION)
    expect(pointerEnv.slot).toBeLessThan(DATA_COUNTER_START)
    // Did not consume the data lane: counter untouched, so the next data chunk
    // in this bucket still lands at j=0.
    expect(stamper.getLocalCounter()![BUCKET]).toBe(0)
    const dataEnv = decodeIndex(
      stamper.stamp(makeAddressInBucket(BUCKET, 2)).index,
    )
    expect(dataEnv.slot).toBe(dataSlot(0, 0, PARTITION_COUNT))
    expect(dataEnv.slot).toBeGreaterThanOrEqual(DATA_COUNTER_START)
  })

  it("state-pointer stamps never share a (bucket, slot) with data stamps", async () => {
    // Guards against a state-pointer SOC falling into a data lane
    // (overstamping user data). Interleave data + state-pointer stamps in one
    // bucket and assert the two occupy disjoint slot ranges: data lives at
    // >= DATA_COUNTER_START, state pointers at the partition's reserved slot
    // (< DATA_COUNTER_START). (State pointers overstamping each OTHER at the
    // same reserved slot is what `entrySalt` deals with — not asserted here.)
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

      const pointerChunk = makeAddressInBucket(BUCKET, 200 + i)
      stamper.reserveStatePointerSlot(pointerChunk, 0)
      const pointerEnv = decodeIndex(stamper.stamp(pointerChunk).index)
      stamper.clearStatePointerSlot()
      // The reserved slot is below the data range, so it can never equal a data slot.
      expect(pointerEnv.slot).toBeLessThan(DATA_COUNTER_START)
      expect(dataSlots.has(pointerEnv.slot)).toBe(false)
    }
  })

  it("withStatePointerSlot serializes concurrent state-pointer writes so neither clobbers the other's reserved slot", async () => {
    // Every state-pointer SOC write shares the single `statePointerSoc`
    // reservation. Were two to run their reserve→stamp windows at once, the
    // second reserve would clobber the first's address, and the first
    // `stamp()` would not match `statePointerSoc` and fall through to a DATA
    // slot (consuming budget + bumping the counter). `withStatePointerSlot`
    // serializes the critical sections so each writer's reservation is intact
    // at stamp time.
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
      await stamper.withStatePointerSlot(chunk, SLOT, async () => {
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

  it("withStatePointerSlot releases the mutex when fn throws, so later writes don't deadlock", async () => {
    // Regression (the reserve/fn-throw guard): if `fn` — the upload — throws,
    // the `finally` must still `clearStatePointerSlot()` and resolve the lock.
    // Otherwise `statePointerLock` stays pending forever and EVERY later
    // state-pointer write on this stamper deadlocks on `await previous`.
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
      stamper.withStatePointerSlot(new Uint8Array(32), SLOT, async () => {
        throw boom
      }),
    ).rejects.toBe(boom)

    // The mutex must have been released by the failed call: the next write
    // completes and routes to the reserved slot. Without the finally-release it
    // would hang forever on `await previous` (the test would time out).
    const chunk = makeAddressInBucket(0x4444, 0x4444)
    const slot = await stamper.withStatePointerSlot(
      chunk,
      SLOT,
      async () => decodeIndex(stamper.stamp(chunk).index).slot,
    )
    expect(slot).toBe(SLOT)
  })

  it("seeds the local counter from the caller (resuming a published counter)", async () => {
    // Device 1 takes partition 1 and resumes from a
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
    // No bindPartition: the slot recorded at marking time is the one used,
    // whatever lane the stamper is bound to when the chunk is stamped.
    const BUCKET = 0x1234
    const chunk = makeAddressInBucket(BUCKET, 7)
    stamper.markReservedUtilizationChunk(chunk, 1)

    const env = decodeIndex(stamper.stamp(chunk).index)
    expect(env.bucket).toBe(BUCKET)
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

  it("getSyncedPointer round-trips through setSyncedPointer (per partition, merge-preserving)", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    const zero = { seq: 1, referenceHex: "ref-zero" }
    const one = { seq: 7, referenceHex: "ref-one" }
    const zeroNext = { seq: 2, referenceHex: "ref-zero-v2" }

    expect(await stamper.getSyncedPointer(0)).toBeUndefined()

    await stamper.setSyncedPointer(0, zero)
    await stamper.setSyncedPointer(1, one)
    expect(await stamper.getSyncedPointer(0)).toEqual(zero)
    expect(await stamper.getSyncedPointer(1)).toEqual(one)

    // Overwriting one partition preserves the other.
    await stamper.setSyncedPointer(0, zeroNext)
    expect(await stamper.getSyncedPointer(0)).toEqual(zeroNext)
    expect(await stamper.getSyncedPointer(1)).toEqual(one)
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

    // A reload (fresh stamper over the same cache) keeps avoiding them.
    const reloaded = await makeStamper(cache)
    reloaded.bindPartition({
      partition: 1,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    expect(reloaded.getProtectedBuckets().has(1234)).toBe(true)
  })

  it("scopes protection to the bound partition and survives setSyncedPointer", async () => {
    const cache = makeRecordingCache()
    const stamper = await makeStamper(cache)
    await stamper.setProtectedStateBuckets(0, [11])
    await stamper.setProtectedStateBuckets(1, [22])
    // Persisting a synced pointer must not drop the protected buckets
    // (both live in the same metadata record).
    await stamper.setSyncedPointer(0, { seq: 1, referenceHex: "ref-zero" })

    const reloaded = await makeStamper(cache)
    reloaded.bindPartition({
      partition: 0,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    expect(reloaded.getProtectedBuckets().has(11)).toBe(true)
    // Partition 1's set does not leak into partition 0's saves.
    expect(reloaded.getProtectedBuckets().has(22)).toBe(false)
    expect(await reloaded.getSyncedPointer(0)).toEqual({
      seq: 1,
      referenceHex: "ref-zero",
    })
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

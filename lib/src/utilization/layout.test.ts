// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId } from "@ethersphere/bee-js"
import {
  CHUNK_SIZE,
  DATA_COUNTER_START,
  NUM_BUCKETS,
  PARTITION_COUNT,
  UINT16_COUNTER_MAX_DEPTH,
  partitionCapacity,
  extractChunk,
  getChunkIndexForBucket,
  getChunkLayout,
  hasBucketCapacity,
  MIN_USABLE_BATCH_DEPTH,
  MIN_USABLE_PARTITION_CAPACITY,
  mergeChunk,
} from "./layout"
import { calculateUtilization, initializeBatchUtilization } from "./state"

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

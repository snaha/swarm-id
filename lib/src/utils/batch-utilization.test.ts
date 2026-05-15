// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId } from "@ethersphere/bee-js"
import { makeContentAddressedChunk } from "../chunk"
import {
  CHUNK_SIZE,
  DATA_COUNTER_START,
  NUM_BUCKETS,
  UINT16_COUNTER_MAX_DEPTH,
  calculateUtilizationUpdate,
  deserializeUint16Array,
  deserializeUint32Array,
  extractChunk,
  getChunkLayout,
  initializeBatchUtilization,
  mergeChunk,
  serializeUint16Array,
  serializeUint32Array,
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

describe("regression: serializeUint32Array round-trip", () => {
  it("round-trips a uint32 buffer", () => {
    const source = new Uint32Array([0, 1, 0xdeadbeef, 0xffffffff])
    const bytes = serializeUint32Array(source)
    expect(bytes.byteLength).toBe(source.length * 4)
    const decoded = deserializeUint32Array(bytes)
    expect(Array.from(decoded)).toEqual(Array.from(source))
  })
})

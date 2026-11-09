// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The partition-state wire layout of a batch created before SBU1 (#463): a
 * fixed uint16 or uint32 counter per bucket, chosen by the batch depth. Kept
 * so such batches stay readable; a new batch packs SBU1 leaves instead.
 */

import { describe, expect, it } from "vitest"
import { CHUNK_SIZE, NUM_BUCKETS } from "../utils/batch-utilization"
import {
  UINT16_COUNTER_MAX_DEPTH,
  extractLegacyChunk,
  legacyChunkLayout,
  legacyLayoutDepth,
  mergeLegacyChunk,
} from "./legacy-counter-codec"

describe("legacy-counter-codec — the pre-SBU1 chunk layout", () => {
  it("packs uint16 counters in 32 chunks up to depth 31, uint32 in 64 above", () => {
    expect(UINT16_COUNTER_MAX_DEPTH).toBe(31)
    expect(legacyChunkLayout(24)).toEqual({
      counterByteSize: 2,
      bucketsPerChunk: 2048,
      numUtilizationChunks: 32,
    })
    expect(legacyChunkLayout(31).numUtilizationChunks).toBe(32)
    expect(legacyChunkLayout(32)).toEqual({
      counterByteSize: 4,
      bucketsPerChunk: 1024,
      numUtilizationChunks: 64,
    })
  })

  it("a scratch drive always takes the uint32 layout: the lane does not bound its counter", () => {
    expect(legacyLayoutDepth(24, false)).toBe(24)
    expect(legacyLayoutDepth(24, true)).toBe(32)
    expect(legacyLayoutDepth(40, true)).toBe(40)
  })

  it("round-trips a counter table through its chunks at both widths", () => {
    for (const depth of [24, 32]) {
      const counters = Uint32Array.from(
        { length: NUM_BUCKETS },
        (_unused, b) => b % 1000,
      )
      const back = new Uint32Array(NUM_BUCKETS)
      const { numUtilizationChunks } = legacyChunkLayout(depth)
      for (let i = 0; i < numUtilizationChunks; i++) {
        const chunk = extractLegacyChunk(counters, i, depth)
        expect(chunk.length).toBe(CHUNK_SIZE)
        mergeLegacyChunk(back, i, chunk, depth)
      }
      expect(back).toEqual(counters)
    }
  })

  it("stores counters little-endian, as every published v1 chunk did", () => {
    const counters = new Uint32Array(NUM_BUCKETS)
    counters[1] = 0x0102
    expect(Array.from(extractLegacyChunk(counters, 0, 24).slice(2, 4))).toEqual(
      [0x02, 0x01],
    )
    expect(Array.from(extractLegacyChunk(counters, 0, 32).slice(4, 8))).toEqual(
      [0x02, 0x01, 0, 0],
    )
  })

  it("refuses a counter the uint16 layout cannot hold", () => {
    const counters = new Uint32Array(NUM_BUCKETS)
    counters[0] = 0x10000
    expect(() => extractLegacyChunk(counters, 0, 24)).toThrow(/uint16/)
    expect(extractLegacyChunk(counters, 0, 32).length).toBe(CHUNK_SIZE)
  })

  it("rejects a chunk index or length outside the layout", () => {
    const counters = new Uint32Array(NUM_BUCKETS)
    expect(() => extractLegacyChunk(counters, 32, 24)).toThrow(/index/)
    expect(() =>
      mergeLegacyChunk(counters, 0, new Uint8Array(100), 24),
    ).toThrow(/length/)
  })
})

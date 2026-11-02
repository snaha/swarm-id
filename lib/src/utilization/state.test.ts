// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId } from "@ethersphere/bee-js"
import { NUM_BUCKETS, PARTITION_COUNT, partitionCapacity } from "./layout"
import { updateAfterWrite, initializeBatchUtilization } from "./state"
import type { UtilizationStoreDB } from "../storage/utilization-store"

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

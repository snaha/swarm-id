// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { RedundancyLevel, Utils } from "@ethersphere/bee-js"
import { CHUNK_SIZE, NUM_BUCKETS, partitionCapacity } from "./batch-utilization"
import {
  DEFAULT_FIT_CONFIDENCE,
  SAVE_OVERHEAD_CHUNKS,
  bytesForChunks,
  chunksForBytes,
  chunksThatFit,
  estimateDriveCapacity,
  estimatePartitionCapacity,
  fitProbability,
  headroomHistogram,
} from "./drive-capacity"

const DEPTH = 22
const SMALL_DEPTH = 20
const ENCRYPTED_FAN_OUT = 64
const PLAIN_FAN_OUT = 128
const MEDIAN = 0.5

function emptyCounters(): Uint32Array {
  return new Uint32Array(NUM_BUCKETS)
}

/** mulberry32: a seeded generator, so the simulation is the same every run */
function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

describe("chunksForBytes", () => {
  it("counts a small save as one chunk plus the save's overhead", () => {
    expect(chunksForBytes(0)).toBe(1 + SAVE_OVERHEAD_CHUNKS)
    expect(chunksForBytes(CHUNK_SIZE)).toBe(1 + SAVE_OVERHEAD_CHUNKS)
  })

  it("adds an encrypted tree's intermediate chunks, 64 references each", () => {
    expect(chunksForBytes(ENCRYPTED_FAN_OUT * CHUNK_SIZE)).toBe(
      ENCRYPTED_FAN_OUT + 1 + SAVE_OVERHEAD_CHUNKS,
    )
    // Twice as many leaves need two intermediates and a root above both
    expect(chunksForBytes(2 * ENCRYPTED_FAN_OUT * CHUNK_SIZE)).toBe(
      2 * ENCRYPTED_FAN_OUT + 2 + 1 + SAVE_OVERHEAD_CHUNKS,
    )
  })

  it("packs 128 references per intermediate chunk when unencrypted", () => {
    expect(chunksForBytes(PLAIN_FAN_OUT * CHUNK_SIZE, false)).toBe(
      PLAIN_FAN_OUT + 1 + SAVE_OVERHEAD_CHUNKS,
    )
  })
})

describe("bytesForChunks", () => {
  it("is zero when not even the smallest save fits", () => {
    expect(bytesForChunks(SAVE_OVERHEAD_CHUNKS)).toBe(0)
  })

  it.each([5, 69, 70, 1000, 123_457])(
    "returns the largest save that writes at most %i chunks",
    (chunks) => {
      const bytes = bytesForChunks(chunks)
      expect(chunksForBytes(bytes)).toBeLessThanOrEqual(chunks)
      expect(chunksForBytes(bytes + CHUNK_SIZE)).toBeGreaterThan(chunks)
    },
  )
})

describe("headroomHistogram", () => {
  it("groups every bucket by the chunks it still takes", () => {
    const capacity = partitionCapacity(DEPTH, 2)
    const counters = emptyCounters()
    counters[0] = 3
    counters[1] = capacity
    // A scratch drive's counter runs past capacity as its lane wraps
    counters[2] = capacity + 5

    const histogram = headroomHistogram(counters, DEPTH)

    expect(histogram.get(capacity)).toBe(NUM_BUCKETS - 3)
    expect(histogram.get(capacity - 3)).toBe(1)
    expect(histogram.get(0)).toBe(2)
  })
})

describe("fitProbability", () => {
  const capacity = partitionCapacity(DEPTH, 2)

  it("is certain for nothing at all", () => {
    expect(fitProbability(headroomHistogram(emptyCounters(), DEPTH), 0)).toBe(1)
  })

  it("is the chance of missing the one full bucket", () => {
    const histogram = new Map([
      [0, 1],
      [capacity, NUM_BUCKETS - 1],
    ])
    const chunks = 1000
    expect(fitProbability(histogram, chunks)).toBeCloseTo(
      Math.exp(-chunks / NUM_BUCKETS),
      6,
    )
  })

  it("is zero for more chunks than free slots", () => {
    const histogram = new Map([
      [0, NUM_BUCKETS - 1],
      [1, 1],
    ])
    expect(fitProbability(histogram, 2)).toBe(0)
  })

  it("falls as the save grows", () => {
    const histogram = headroomHistogram(emptyCounters(), DEPTH)
    const steps = [1e5, 5e5, 1e6, 1.5e6]
    const probabilities = steps.map((chunks) =>
      fitProbability(histogram, chunks),
    )
    for (let i = 1; i < probabilities.length; i++) {
      expect(probabilities[i]).toBeLessThan(probabilities[i - 1])
    }
  })
})

describe("chunksThatFit", () => {
  const histogram = headroomHistogram(emptyCounters(), SMALL_DEPTH)

  it("finds the edge where the fit probability crosses the confidence", () => {
    const chunks = chunksThatFit(histogram)
    expect(fitProbability(histogram, chunks)).toBeGreaterThanOrEqual(
      DEFAULT_FIT_CONFIDENCE,
    )
    expect(fitProbability(histogram, chunks + 1)).toBeLessThan(
      DEFAULT_FIT_CONFIDENCE,
    )
  })

  it("promises less at a higher confidence", () => {
    expect(chunksThatFit(histogram)).toBeLessThan(
      chunksThatFit(histogram, MEDIAN),
    )
  })

  it("is zero for a partition with no free slot", () => {
    expect(chunksThatFit(new Map([[0, NUM_BUCKETS]]))).toBe(0)
  })

  it.each([0, -0.1, 1.5, Number.NaN])(
    "rejects a confidence of %s",
    (confidence) => {
      expect(() => chunksThatFit(histogram, confidence)).toThrow(RangeError)
    },
  )

  it("agrees with simulated uploads into an empty partition", () => {
    const capacity = partitionCapacity(SMALL_DEPTH, 2)
    const random = seededRandom(1)
    const runs = 101
    const filled: number[] = []
    for (let run = 0; run < runs; run++) {
      const counters = emptyCounters()
      let chunks = 0
      for (;;) {
        const bucket = Math.floor(random() * NUM_BUCKETS)
        if (counters[bucket] >= capacity) break
        counters[bucket]++
        chunks++
      }
      filled.push(chunks)
    }
    filled.sort((a, b) => a - b)
    const median = filled[Math.floor(runs / 2)]

    const tolerance = 0.05
    expect(
      Math.abs(chunksThatFit(histogram, MEDIAN) - median) / median,
    ).toBeLessThan(tolerance)
  })
})

describe("estimatePartitionCapacity", () => {
  const capacity = partitionCapacity(DEPTH, 2)

  it("has everything left when empty", () => {
    const figures = estimatePartitionCapacity(1, emptyCounters(), DEPTH)
    expect(figures).toEqual({
      partition: 1,
      sizeBytes: figures.leftBytes,
      usedBytes: 0,
      leftBytes: figures.sizeBytes,
    })
    expect(figures.sizeBytes).toBeGreaterThan(0)
  })

  it("counts every written slot as used", () => {
    const counters = emptyCounters()
    counters[0] = 2
    counters[1] = 5
    const figures = estimatePartitionCapacity(0, counters, DEPTH)
    expect(figures.usedBytes).toBe(7 * CHUNK_SIZE)
    expect(figures.leftBytes).toBeLessThan(figures.sizeBytes)
  })

  it("has a little left once one bucket is full", () => {
    const counters = emptyCounters()
    counters[0] = capacity
    const figures = estimatePartitionCapacity(0, counters, DEPTH)
    expect(figures.leftBytes).toBeGreaterThan(0)
    expect(figures.leftBytes).toBeLessThan(figures.sizeBytes / 10)
  })

  it("caps a wrapped counter at the lane's capacity", () => {
    const counters = emptyCounters()
    counters[0] = capacity * 3
    const figures = estimatePartitionCapacity(0, counters, DEPTH)
    expect(figures.usedBytes).toBe(capacity * CHUNK_SIZE)
  })

  // The identity UI labels a drive with bee-js's effective volume one depth
  // down, a partition being half of every bucket's slots
  it.each([20, 22, 24, 26, 28, 30])(
    "sizes an empty partition of a depth-%i drive as bee-js's effective volume",
    (depth) => {
      const { sizeBytes } = estimatePartitionCapacity(0, emptyCounters(), depth)
      const label = Utils.getStampEffectiveBytes(
        depth - 1,
        true,
        RedundancyLevel.OFF,
      )
      const tolerance = 0.02
      expect(Math.abs(sizeBytes - label) / label).toBeLessThan(tolerance)
    },
  )

  it("fits more when saves are unencrypted", () => {
    const encrypted = estimatePartitionCapacity(0, emptyCounters(), DEPTH)
    const plain = estimatePartitionCapacity(0, emptyCounters(), DEPTH, {
      encrypt: false,
    })
    expect(plain.leftBytes).toBeGreaterThan(encrypted.leftBytes)
  })
})

describe("estimateDriveCapacity", () => {
  it("adds up its partitions", () => {
    const busy = emptyCounters()
    busy.fill(3)
    const drive = estimateDriveCapacity(
      [
        { partition: 0, dataCounters: busy },
        { partition: 1, dataCounters: emptyCounters() },
      ],
      DEPTH,
    )
    const [first, second] = drive.partitions
    expect(first.partition).toBe(0)
    expect(second.partition).toBe(1)
    expect(drive.sizeBytes).toBe(first.sizeBytes + second.sizeBytes)
    expect(drive.usedBytes).toBe(first.usedBytes + second.usedBytes)
    expect(drive.leftBytes).toBe(first.leftBytes + second.leftBytes)
    expect(first.leftBytes).toBeLessThan(second.leftBytes)
  })
})

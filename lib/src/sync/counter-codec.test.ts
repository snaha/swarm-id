// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The leaf encoding is Nectar's SBU1 (nxm-rs/nectar, docs/spec/sbu1.md §4, §6,
 * §12), so its golden vector pins ours: a different width choice, exception
 * rule, or bit order would change these bytes.
 */

import { describe, expect, it } from "vitest"
import { Binary } from "cafe-utility"
import { NUM_BUCKETS } from "../utils/batch-utilization"
import {
  MAX_DELTA_WIDTH,
  MAX_EXCEPTIONS,
  chooseFrame,
  decodeCounters,
  encodeCounters,
  frameFits,
  leafByteLength,
  leafCount,
} from "./counter-codec"

/** SBU1 §12, second vector: `100 + (b mod 50)`, two outliers. */
function goldenCounters(): Uint32Array {
  const counts = new Uint32Array(NUM_BUCKETS)
  for (let b = 0; b < NUM_BUCKETS; b++) counts[b] = 100 + (b % 50)
  counts[0x1234] = 5000
  counts[0xcbe5] = 8192
  return counts
}

describe("counter-codec — SBU1 golden vector", () => {
  it("picks base 100, width 6, two exceptions, thirteen leaves", () => {
    const counters = goldenCounters()
    expect(chooseFrame(counters)).toEqual({ base: 100, width: 6 })
    const encoded = encodeCounters(counters, { base: 100, width: 6 })
    expect(encoded.exceptions).toEqual([
      { bucket: 0x1234, count: 5000 },
      { bucket: 0xcbe5, count: 8192 },
    ])
    expect(leafCount(6)).toBe(13)
    expect(encoded.leaves).toHaveLength(13)
    expect(encoded.leaves.slice(0, 12).map((l) => l.length)).toEqual(
      Array(12).fill(4096),
    )
    expect(encoded.leaves[12]).toHaveLength(3)
    expect(leafByteLength(6, 12)).toBe(3)
  })

  it("packs deltas MSB-first with no gaps", () => {
    const encoded = encodeCounters(goldenCounters(), { base: 100, width: 6 })
    expect(Binary.uint8ArrayToHex(encoded.leaves[0].slice(0, 8))).toBe(
      "0010831051872092",
    )
    expect(Binary.uint8ArrayToHex(encoded.leaves[12])).toBe("8218a3")
  })

  it("writes all ones into an exception bucket's field", () => {
    const encoded = encodeCounters(goldenCounters(), { base: 100, width: 6 })
    // Bucket 0x1234 is in leaf 0 (5461 buckets per leaf) at bit 6 · 0x1234.
    const bit = 6 * 0x1234
    let field = 0
    for (let i = 0; i < 6; i++) {
      const at = bit + i
      field =
        (field << 1) | ((encoded.leaves[0][at >> 3] >> (7 - (at & 7))) & 1)
    }
    expect(field).toBe(0b111111)
  })

  it("decodes back to the same table", () => {
    const counters = goldenCounters()
    const encoded = encodeCounters(counters, chooseFrame(counters))
    expect(Array.from(decodeCounters(encoded))).toEqual(Array.from(counters))
  })
})

describe("counter-codec — frames", () => {
  it("an empty table is width 0 with no leaves and no exceptions", () => {
    const counters = new Uint32Array(NUM_BUCKETS)
    expect(chooseFrame(counters)).toEqual({ base: 0, width: 0 })
    const encoded = encodeCounters(counters, { base: 0, width: 0 })
    expect(encoded.leaves).toEqual([])
    expect(encoded.exceptions).toEqual([])
    expect(Array.from(decodeCounters(encoded))).toEqual(Array.from(counters))
  })

  it("a few touched buckets ride as exceptions at width 0", () => {
    const counters = new Uint32Array(NUM_BUCKETS)
    counters[7] = 3
    counters[70_000 % NUM_BUCKETS] = 1
    counters[65535] = 9
    const frame = chooseFrame(counters)
    expect(frame).toEqual({ base: 0, width: 0 })
    const encoded = encodeCounters(counters, frame)
    expect(encoded.exceptions.map((e) => e.bucket)).toEqual([7, 4464, 65535])
    expect(Array.from(decodeCounters(encoded))).toEqual(Array.from(counters))
  })

  it("more than MAX_EXCEPTIONS touched buckets force a width", () => {
    const counters = new Uint32Array(NUM_BUCKETS)
    for (let b = 0; b <= MAX_EXCEPTIONS; b++) counters[b * 3] = 1
    expect(chooseFrame(counters).width).toBeGreaterThan(0)
    expect(frameFits(counters, { base: 0, width: 0 })).toBe(false)
  })

  it("a previous frame still fits while its base is at most the minimum", () => {
    const counters = goldenCounters()
    expect(frameFits(counters, { base: 90, width: 6 })).toBe(true)
    expect(frameFits(counters, { base: 101, width: 6 })).toBe(false)
    expect(frameFits(counters, { base: 100, width: 5 })).toBe(false)
    expect(() => encodeCounters(counters, { base: 101, width: 6 })).toThrow(
      /base/,
    )
  })

  it("rejects a spread no allowed width can hold", () => {
    const counters = new Uint32Array(NUM_BUCKETS)
    for (let b = 0; b < NUM_BUCKETS; b++) counters[b] = b * 200
    expect(() => chooseFrame(counters)).toThrow(/width/)
    expect(() =>
      encodeCounters(counters, { base: 0, width: MAX_DELTA_WIDTH + 1 }),
    ).toThrow(/width/)
  })

  it("round-trips a Poisson-like table at every width up to the cap", () => {
    for (const mean of [1, 40, 3000, 2 ** 20]) {
      const counters = new Uint32Array(NUM_BUCKETS)
      for (let b = 0; b < NUM_BUCKETS; b++) {
        // Deterministic spread of about ±10% around the mean.
        counters[b] = Math.floor(
          mean + ((b * 2654435761) % 1000) * (mean / 5000),
        )
      }
      const frame = chooseFrame(counters)
      const encoded = encodeCounters(counters, frame)
      expect(Array.from(decodeCounters(encoded))).toEqual(Array.from(counters))
    }
  })
})

describe("counter-codec — decoder validation", () => {
  const encoded = () =>
    encodeCounters(goldenCounters(), { base: 100, width: 6 })

  it("rejects a wrong leaf count", () => {
    const e = encoded()
    expect(() => decodeCounters({ ...e, leaves: e.leaves.slice(1) })).toThrow(
      /leaves/,
    )
  })

  it("rejects a leaf of the wrong length", () => {
    const e = encoded()
    e.leaves[3] = e.leaves[3].slice(1)
    expect(() => decodeCounters(e)).toThrow(/leaf 3/)
  })

  it("rejects non-zero padding bits", () => {
    // Width 5: the last leaf holds 6 buckets in 30 bits, so 2 padding bits.
    const counters = new Uint32Array(NUM_BUCKETS)
    for (let b = 0; b < NUM_BUCKETS; b++) counters[b] = 100 + (b % 20)
    const e = encodeCounters(counters, { base: 100, width: 5 })
    const last = e.leaves.length - 1
    expect(e.leaves[last]).toHaveLength(4)
    e.leaves[last][3] |= 1
    expect(() => decodeCounters(e)).toThrow(/padding/)
  })

  it("rejects exceptions out of order or out of range", () => {
    const e = encoded()
    expect(() =>
      decodeCounters({ ...e, exceptions: [...e.exceptions].reverse() }),
    ).toThrow(/ascending/)
    expect(() =>
      decodeCounters({
        ...e,
        exceptions: [...e.exceptions, { bucket: NUM_BUCKETS, count: 1 }],
      }),
    ).toThrow(/bucket/)
  })
})

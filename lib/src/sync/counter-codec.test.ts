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

/**
 * SBU1 §12, the 14-chunk vector's root payload, verbatim from the spec. Its
 * 13 leaf digests pin every byte of every leaf; the rest of the root is
 * Nectar's own layout, parsed here only to reach them.
 */
const SPEC_LARGE_ROOT_HEX =
  "5342553142424242424242424242424242424242424242424242424242424242424242421d100006000000000000000100000000007cb19900000064000e000d000200001234000013880000cbe500002000000000690000007d00000091000000880000007a000000760000006e00000079000000810000006c0000007d000000910000007a0000006b9c8de349a3c4b573d45db35c3585fcbe2e2c20d999ee2a5ead8c1600b5a5428a645b990e3f426220eda38496a262f6968b8a4d42f7becb602c51576f19112fe9fb1f9017218e72abf21947cb3290726dd5129c47e50562a22dfcaa64340dd76d5bb4cba42453e6cb20f8c1c0892bf2bf4873bd3b4850787f171952b662346708660c94f587fa4516af6eb9b083513f245d9bd9fc0559f48356021e51892201fb197b58a495d1305292904a61906b02e37e68101e3657b4e2ff9661d705a004c36ebbe152c039d8887c067cc8fa86636c62afc5f21cd8ca1afc4f546e77882de86c3e8248ce84ffd4c440f28c638007df05e9ea75a713a308e7ba48e6066903c88e6e5e60e48477ca6202b2333d5c06968f67baae3c03105bbb4a7a8491b04ce6f5c8fc3151cdfbc3136e8f0adac485df7ae4d866e1cce1cd1aa0d1cbbf33f19bf28b0420c19fcadaf197e1eaff36f8151ec107d59ad4e6d3a4cf1492a77828991d9c30151c90772df348891a627fa9a5046919dba774e2a388819e9e11aba2c68724aa66f7e98c8ec09b71685da6a49cf173a390ac1662a9e120712062d20fb8"

describe("counter-codec — SBU1 §12 root vector", () => {
  const SPEC_BATCH_ID = new Uint8Array(32).fill(0x42)
  const SPEC_OWNER = new Uint8Array(20).fill(0x11)
  const ROOT_HEADER_BYTES = 66
  const DIGEST_BYTES = 32
  const SLOT_BYTES = 4
  const EXCEPTION_BYTES = 8

  /**
   * SBU1 §3: snapshot chunk `n` is the single-owner chunk with id
   * `keccak256("swarm-batch-usage" ‖ batch_id ‖ u16_be(n))`, at address
   * `keccak256(id ‖ owner)`; its bucket is the address's first 16 bits.
   */
  function snapshotChunkBucket(n: number): number {
    const index = new Uint8Array(2)
    new DataView(index.buffer).setUint16(0, n, false)
    const id = Binary.keccak256(
      Binary.concatBytes(
        new TextEncoder().encode("swarm-batch-usage"),
        SPEC_BATCH_ID,
        index,
      ),
    )
    const address = Binary.keccak256(Binary.concatBytes(id, SPEC_OWNER))
    return (address[0] << 8) | address[1]
  }

  it("encodes every leaf to the digest the spec's root commits to", () => {
    const root = Binary.hexToUint8Array(SPEC_LARGE_ROOT_HEX)
    const view = new DataView(root.buffer, root.byteOffset, root.byteLength)
    expect(new TextDecoder().decode(root.slice(0, 4))).toBe("SBU1")
    expect(root.slice(4, 36)).toEqual(SPEC_BATCH_ID)
    const width = view.getUint8(39)
    const sum = view.getBigUint64(48, false)
    const base = view.getUint32(56, false)
    const allocated = view.getUint16(60, false)
    const leafCountInRoot = view.getUint16(62, false)
    const exceptionCount = view.getUint16(64, false)
    expect({ allocated, leafCountInRoot, exceptionCount }).toEqual({
      allocated: 14,
      leafCountInRoot: 13,
      exceptionCount: 2,
    })

    // The table the spec encoded: §12's counts, plus the slot each of the 14
    // snapshot chunks took from its own bucket's watermark (§9: one per round,
    // in chunk order), which advances that counter by one.
    const counters = goldenCounters()
    let at = ROOT_HEADER_BYTES
    const exceptions = Array.from({ length: exceptionCount }, (_, i) => ({
      bucket: view.getUint32(at + i * EXCEPTION_BYTES, false),
      count: view.getUint32(at + i * EXCEPTION_BYTES + 4, false),
    }))
    at += exceptionCount * EXCEPTION_BYTES
    let stamped = 0n
    for (let n = 0; n < allocated; n++) {
      const bucket = snapshotChunkBucket(n)
      const slot = view.getUint32(at + n * SLOT_BYTES, false)
      expect(slot, `chunk ${n} slot`).toBe(counters[bucket])
      counters[bucket]++
      stamped++
    }
    at += allocated * SLOT_BYTES
    const digests = Array.from({ length: leafCountInRoot }, (_, i) =>
      root.slice(at + i * DIGEST_BYTES, at + (i + 1) * DIGEST_BYTES),
    )
    expect(at + leafCountInRoot * DIGEST_BYTES).toBe(root.length)

    // Our canonical frame and exceptions are the root's.
    const frame = chooseFrame(counters)
    expect(frame).toEqual({ base, width })
    const encoded = encodeCounters(counters, frame)
    expect(encoded.exceptions).toEqual(exceptions)
    let total = 0n
    for (const count of counters) total += BigInt(count)
    expect(total).toBe(sum)
    expect(stamped).toBe(14n)

    // And every leaf hashes to the digest the root holds for it.
    expect(encoded.leaves).toHaveLength(leafCountInRoot)
    for (let i = 0; i < leafCountInRoot; i++) {
      expect(
        Binary.uint8ArrayToHex(Binary.keccak256(encoded.leaves[i])),
        `leaf ${i} digest`,
      ).toBe(Binary.uint8ArrayToHex(digests[i]))
    }
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

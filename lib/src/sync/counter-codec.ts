// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Patched frame-of-reference encoding of the 65,536-bucket counter table —
 * the leaf encoding of Nectar's SBU1 usage snapshot (nxm-rs/nectar,
 * `docs/spec/sbu1.md` §4 and §6), byte-exact so its golden vectors pin ours.
 *
 * A *frame* is a `base` (at most the smallest counter) and a bit width `w`.
 * Every bucket stores `count − base` as a `w`-bit field, packed MSB-first with
 * no gaps; a bucket whose delta does not fit is an *exception*: its field is
 * all ones and its absolute count rides in a separate list. A leaf holds
 * `floor(32768 / w)` buckets (4096 bytes at `w` bits), so the leaf count
 * follows from `w` alone, and `w` follows the *spread* of the counters, not
 * the batch depth: a dilute changes no byte (#463). Lane counters are Poisson
 * over the buckets, so a real drive packs into 8–20 leaves where a fixed
 * uint16 needed 32 and uint32 64, on the takeover read as much as the publish.
 *
 * The SBU1 root is not shared: our reference chunk carries the frame, the
 * exceptions and *encrypted* references to the leaves (`partition-state.ts`).
 */

import { NUM_BUCKETS } from "../utils/batch-utilization"

/** Payload size of a full leaf, in bits (SBU1 §6). */
const LEAF_BITS = 32768

/** Exceptions a frame may carry (SBU1 §4). */
export const MAX_EXCEPTIONS = 128

/**
 * Widest delta we encode. SBU1 allows 32; our reference chunk must hold the
 * frame, 128 exceptions and a 64-byte encrypted reference per leaf in one
 * chunk, which 47 leaves (width 23) is the most of. A per-bucket spread above
 * 2^23 − 1 would need it — about 2^39 chunks through one lane.
 */
export const MAX_DELTA_WIDTH = 23

/** What one leaf costs in the reference chunk, for the width choice. */
const LEAF_REFERENCE_BYTES = 64

/** What one exception costs in the reference chunk. */
const EXCEPTION_BYTES = 8

const BITS_PER_BYTE = 8

export interface CounterFrame {
  /** At most the smallest counter; deltas are measured from it. */
  base: number
  /** Bits per delta, 0 to `MAX_DELTA_WIDTH`. */
  width: number
}

export interface CounterException {
  bucket: number
  count: number
}

export interface EncodedCounters {
  frame: CounterFrame
  /** In strictly ascending bucket order. */
  exceptions: CounterException[]
  /** `leafCount(frame.width)` leaves; leaf `i` covers `leafBucketRange(width, i)`. */
  leaves: Uint8Array[]
}

function assertWidth(width: number): void {
  if (!Number.isInteger(width) || width < 0 || width > MAX_DELTA_WIDTH) {
    throw new Error(
      `counter-codec: width ${width} out of range 0..${MAX_DELTA_WIDTH}`,
    )
  }
}

/** Buckets in a full leaf at `width` (> 0). */
function bucketsPerLeaf(width: number): number {
  return Math.floor(LEAF_BITS / width)
}

/** How many leaves a table takes at `width`; none at width 0. */
export function leafCount(width: number): number {
  assertWidth(width)
  return width === 0 ? 0 : Math.ceil(NUM_BUCKETS / bucketsPerLeaf(width))
}

/** The half-open bucket range leaf `leaf` covers at `width`. */
export function leafBucketRange(
  width: number,
  leaf: number,
): { start: number; end: number } {
  const per = bucketsPerLeaf(width)
  return { start: leaf * per, end: Math.min((leaf + 1) * per, NUM_BUCKETS) }
}

/** Byte length of leaf `leaf` at `width` — the last leaf may be short. */
export function leafByteLength(width: number, leaf: number): number {
  const { start, end } = leafBucketRange(width, leaf)
  return Math.ceil(((end - start) * width) / BITS_PER_BYTE)
}

/** Delta at or above this marks an exception (all ones) at `width` ≥ 1. */
function exceptionThreshold(width: number): number {
  return 2 ** width - 1
}

/**
 * Exceptions `frame` would need for `counters`, or `undefined` once it is
 * clear the frame does not fit: a counter below `base`, or more than
 * `MAX_EXCEPTIONS` deltas outside the width.
 */
function exceptionsFor(
  counters: Uint32Array,
  frame: CounterFrame,
): CounterException[] | undefined {
  const { base, width } = frame
  const threshold = width === 0 ? 0 : exceptionThreshold(width)
  const exceptions: CounterException[] = []
  for (let bucket = 0; bucket < NUM_BUCKETS; bucket++) {
    const count = counters[bucket]
    if (count < base) return undefined
    if (count - base >= threshold && (width > 0 || count > base)) {
      if (exceptions.length === MAX_EXCEPTIONS) return undefined
      exceptions.push({ bucket, count })
    }
  }
  return exceptions
}

/** Whether `counters` can be encoded under `frame` (a previous publish's). */
export function frameFits(counters: Uint32Array, frame: CounterFrame): boolean {
  return (
    frame.width <= MAX_DELTA_WIDTH &&
    exceptionsFor(counters, frame) !== undefined
  )
}

/**
 * The canonical frame (SBU1 §4): `base = min`, then the width whose packed
 * bits plus exception and reference bytes are fewest, ties to the narrower.
 */
export function chooseFrame(counters: Uint32Array): CounterFrame {
  let base = counters[0]
  for (let bucket = 1; bucket < NUM_BUCKETS; bucket++) {
    if (counters[bucket] < base) base = counters[bucket]
  }
  let best: { frame: CounterFrame; size: number } | undefined
  for (let width = 0; width <= MAX_DELTA_WIDTH; width++) {
    const frame = { base, width }
    const exceptions = exceptionsFor(counters, frame)
    if (exceptions === undefined) continue
    const size =
      Math.ceil((NUM_BUCKETS * width) / BITS_PER_BYTE) +
      EXCEPTION_BYTES * exceptions.length +
      LEAF_REFERENCE_BYTES * leafCount(width)
    if (best === undefined || size < best.size) best = { frame, size }
  }
  if (best === undefined) {
    throw new Error(
      `counter-codec: no width up to ${MAX_DELTA_WIDTH} holds this spread`,
    )
  }
  return best.frame
}

/** Encode `counters` under `frame`; throws when the frame does not fit. */
export function encodeCounters(
  counters: Uint32Array,
  frame: CounterFrame,
): EncodedCounters {
  assertWidth(frame.width)
  const exceptions = exceptionsFor(counters, frame)
  if (exceptions === undefined) {
    throw new Error(
      `counter-codec: frame base=${frame.base} width=${frame.width} does not fit (a counter below base, or over ${MAX_EXCEPTIONS} exceptions)`,
    )
  }
  const { base, width } = frame
  const leaves: Uint8Array[] = []
  if (width > 0) {
    const allOnes = exceptionThreshold(width)
    for (let leaf = 0; leaf < leafCount(width); leaf++) {
      const { start, end } = leafBucketRange(width, leaf)
      const out = new Uint8Array(leafByteLength(width, leaf))
      // Bit accumulator: at most `width + 7` live bits, so plain 32-bit ops.
      let acc = 0
      let bits = 0
      let at = 0
      for (let bucket = start; bucket < end; bucket++) {
        const delta = counters[bucket] - base
        acc = ((acc << width) | (delta >= allOnes ? allOnes : delta)) >>> 0
        bits += width
        while (bits >= BITS_PER_BYTE) {
          bits -= BITS_PER_BYTE
          out[at++] = (acc >>> bits) & 0xff
        }
        acc &= (1 << bits) - 1
      }
      if (bits > 0) out[at] = (acc << (BITS_PER_BYTE - bits)) & 0xff
      leaves.push(out)
    }
  }
  return { frame, exceptions, leaves }
}

/**
 * Decode leaves and exceptions back into a counter table, rejecting a leaf
 * set or exception list the frame does not describe (SBU1 §7).
 */
export function decodeCounters(encoded: EncodedCounters): Uint32Array {
  const { base, width } = encoded.frame
  assertWidth(width)
  const { exceptions, leaves } = encoded
  if (exceptions.length > MAX_EXCEPTIONS) {
    throw new Error(`counter-codec: ${exceptions.length} exceptions`)
  }
  for (let i = 0; i < exceptions.length; i++) {
    const { bucket } = exceptions[i]
    if (!Number.isInteger(bucket) || bucket < 0 || bucket >= NUM_BUCKETS) {
      throw new Error(`counter-codec: exception bucket ${bucket} out of range`)
    }
    if (i > 0 && bucket <= exceptions[i - 1].bucket) {
      throw new Error("counter-codec: exception buckets not ascending")
    }
  }
  const expectedLeaves = leafCount(width)
  if (leaves.length !== expectedLeaves) {
    throw new Error(
      `counter-codec: ${leaves.length} leaves, width ${width} takes ${expectedLeaves}`,
    )
  }
  const counters = new Uint32Array(NUM_BUCKETS).fill(base)
  for (let leaf = 0; leaf < leaves.length; leaf++) {
    const bytes = leaves[leaf]
    const expectedLength = leafByteLength(width, leaf)
    if (bytes.length !== expectedLength) {
      throw new Error(
        `counter-codec: leaf ${leaf} has ${bytes.length} bytes, expected ${expectedLength}`,
      )
    }
    const { start, end } = leafBucketRange(width, leaf)
    let acc = 0
    let bits = 0
    let at = 0
    for (let bucket = start; bucket < end; bucket++) {
      while (bits < width) {
        acc = ((acc << BITS_PER_BYTE) | bytes[at++]) >>> 0
        bits += BITS_PER_BYTE
      }
      bits -= width
      counters[bucket] = base + ((acc >>> bits) & exceptionThreshold(width))
      acc &= (1 << bits) - 1
    }
    if (acc !== 0) {
      throw new Error(`counter-codec: leaf ${leaf} has non-zero padding bits`)
    }
  }
  // Overlay after unpacking: an exception's field is ignored (SBU1 §4).
  for (const { bucket, count } of exceptions) counters[bucket] = count
  return counters
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The partition-state wire layout of a batch created before SBU1 (#463): a
 * fixed-width counter per bucket, little-endian, `CHUNK_SIZE` bytes per chunk,
 * the width chosen by the batch depth. A batch keeps the format it was created
 * with (`PostageStamp.stateFormat`), so these chunks stay readable and
 * writable for as long as such batches exist; a new batch packs SBU1 leaves
 * (`counter-codec.ts`) instead. Nothing here reads the IndexedDB cache, which
 * is one fixed uint32 layout for every batch.
 *
 * A dilute across `UINT16_COUNTER_MAX_DEPTH` would change this layout under
 * the published chunks, so the UI refuses it for such a batch
 * (`diluteDepthCeiling`); the SBU1 format carries no depth and has no such
 * ceiling.
 */

import {
  CHUNK_SIZE,
  NUM_BUCKETS,
  deserializeUint32Array,
  serializeUint32Array,
} from "../utils/batch-utilization"

/**
 * Deepest batch whose per-bucket counter fits a uint16: at depth D the counter
 * caps at 2^(D−16), 32,768 at 31 and 65,536 at 32 (#243).
 */
export const UINT16_COUNTER_MAX_DEPTH = 31

const COUNTER_BYTES_UINT16 = 2
const COUNTER_BYTES_UINT32 = 4
const UINT16_MAX = 0xffff

export interface LegacyChunkLayout {
  counterByteSize: 2 | 4
  bucketsPerChunk: number
  numUtilizationChunks: number
}

/**
 * The depth whose layout a legacy drive's counters serialize at. A scratch
 * drive's counter wraps within its lane (#862), so the lane does not bound it
 * and uint16 would overflow: it always takes the uint32 layout.
 */
export function legacyLayoutDepth(depth: number, scratch: boolean): number {
  return scratch ? Math.max(depth, UINT16_COUNTER_MAX_DEPTH + 1) : depth
}

/** uint16 counters in 32 chunks up to `UINT16_COUNTER_MAX_DEPTH`, uint32 in 64 above. */
export function legacyChunkLayout(layoutDepth: number): LegacyChunkLayout {
  const counterByteSize =
    layoutDepth <= UINT16_COUNTER_MAX_DEPTH
      ? COUNTER_BYTES_UINT16
      : COUNTER_BYTES_UINT32
  const bucketsPerChunk = CHUNK_SIZE / counterByteSize
  return {
    counterByteSize,
    bucketsPerChunk,
    numUtilizationChunks: NUM_BUCKETS / bucketsPerChunk,
  }
}

function assertLegacyChunkIndex(
  chunkIndex: number,
  layout: LegacyChunkLayout,
): void {
  if (chunkIndex < 0 || chunkIndex >= layout.numUtilizationChunks) {
    throw new Error(
      `Invalid legacy chunk index: ${chunkIndex} (must be 0-${layout.numUtilizationChunks - 1})`,
    )
  }
}

/** The `CHUNK_SIZE`-byte chunk `chunkIndex` of `counters` at `layoutDepth`. */
export function extractLegacyChunk(
  counters: Uint32Array,
  chunkIndex: number,
  layoutDepth: number,
): Uint8Array {
  const layout = legacyChunkLayout(layoutDepth)
  assertLegacyChunkIndex(chunkIndex, layout)
  const start = chunkIndex * layout.bucketsPerChunk
  const slice = counters.slice(start, start + layout.bucketsPerChunk)
  if (layout.counterByteSize === COUNTER_BYTES_UINT32) {
    return serializeUint32Array(slice)
  }
  const out = new Uint8Array(CHUNK_SIZE)
  const view = new DataView(out.buffer)
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] > UINT16_MAX) {
      throw new Error(
        `Counter at bucket ${start + i} (${slice[i]}) exceeds the uint16 layout`,
      )
    }
    view.setUint16(i * COUNTER_BYTES_UINT16, slice[i], true)
  }
  return out
}

/** Merge chunk `chunkIndex`, serialized at `layoutDepth`, into `counters`. */
export function mergeLegacyChunk(
  counters: Uint32Array,
  chunkIndex: number,
  chunk: Uint8Array,
  layoutDepth: number,
): void {
  const layout = legacyChunkLayout(layoutDepth)
  assertLegacyChunkIndex(chunkIndex, layout)
  if (chunk.length !== CHUNK_SIZE) {
    throw new Error(
      `Invalid legacy chunk length: ${chunk.length} (expected ${CHUNK_SIZE})`,
    )
  }
  const start = chunkIndex * layout.bucketsPerChunk
  if (layout.counterByteSize === COUNTER_BYTES_UINT32) {
    counters.set(deserializeUint32Array(chunk), start)
    return
  }
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  for (let i = 0; i < layout.bucketsPerChunk; i++) {
    counters[start + i] = view.getUint16(i * COUNTER_BYTES_UINT16, true)
  }
}

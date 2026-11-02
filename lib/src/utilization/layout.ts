// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a batch's utilisation lives: buckets, slots and the partition lanes
 * that share them, and how the per-bucket counters are cut into chunks.
 */

import {
  COUNTER_BYTES_UINT16,
  COUNTER_BYTES_UINT32,
  deserializeUint16Array,
  deserializeUint32Array,
  serializeUint16Array,
  serializeUint32Array,
} from "./codec"

// ============================================================================
// Constants
// ============================================================================

/** Number of buckets in a postage batch (2^16) */
export const NUM_BUCKETS = 65536

/** Bucket depth parameter (determines bucket count) */
export const BUCKET_DEPTH = 16

/**
 * Number of partitions the per-bucket slot space is divided into for
 * multi-device sharing of a single postage batch. With K=2, partition 0
 * uses data slots `{DATA_COUNTER_START + 0, DATA_COUNTER_START + 2, …}` and
 * partition 1 uses `{DATA_COUNTER_START + 1, DATA_COUNTER_START + 3, …}`.
 * See docs/Postage-Batch-Partitioning.md.
 */
export const PARTITION_COUNT = 2

/** First data slot index; reserved slots `[0, PARTITION_COUNT)` precede it. */
export const DATA_COUNTER_START = PARTITION_COUNT

/** Size of each chunk in bytes */
export const CHUNK_SIZE = 4096

/**
 * Maximum batch depth at which a uint16 per-bucket counter is sufficient.
 *
 * At depth D the post-stamp counter caps at 2^(D-16). uint16 can hold
 * 0..65535; depth 31 → 32768 (fits), depth 32 → 65536 (overflows).
 * For depth > UINT16_COUNTER_MAX_DEPTH the serializer falls back to uint32.
 *
 * Issue: https://github.com/snaha/swarm-id/issues/243
 */
export const UINT16_COUNTER_MAX_DEPTH = 31

/**
 * Per-batch-depth chunk layout for the utilization state.
 *
 * The on-chunk counter representation switches between uint16 and uint32
 * based on whether the maximum slot index for the given batch depth fits
 * in 16 bits. Each utilization chunk is always CHUNK_SIZE bytes; the
 * number of buckets it covers — and thus the number of chunks needed —
 * doubles when counters shrink from 4 bytes to 2.
 */
export interface ChunkLayout {
  /** Bytes per per-bucket counter on disk / on the wire */
  counterByteSize: 2 | 4
  /** Number of buckets packed into a single CHUNK_SIZE-byte chunk */
  bucketsPerChunk: number
  /** Total number of utilization chunks for one batch */
  numUtilizationChunks: number
}

/**
 * The depth whose layout a drive's counters serialize at. A scratch drive's
 * counter wraps within its lane (#862), so the lane no longer bounds it and
 * uint16 would overflow: it always takes the uint32 layout. Every reader and
 * writer of the counters goes through this, so all devices agree — the kind
 * is fixed when the drive is created.
 */
export function counterLayoutDepth(
  batchDepth: number,
  scratch: boolean,
): number {
  return scratch
    ? Math.max(batchDepth, UINT16_COUNTER_MAX_DEPTH + 1)
    : batchDepth
}

/**
 * Pick the on-disk chunk layout for a given batch depth.
 */
export function getChunkLayout(batchDepth: number): ChunkLayout {
  const counterByteSize =
    batchDepth <= UINT16_COUNTER_MAX_DEPTH
      ? COUNTER_BYTES_UINT16
      : COUNTER_BYTES_UINT32
  const bucketsPerChunk = CHUNK_SIZE / counterByteSize
  const numUtilizationChunks = NUM_BUCKETS / bucketsPerChunk
  return { counterByteSize, bucketsPerChunk, numUtilizationChunks }
}

// ============================================================================
// Bucket Mapping
// ============================================================================

/**
 * Calculate which bucket a chunk belongs to based on its address.
 * Uses the first 2 bytes of the chunk address as a big-endian uint16.
 *
 * This matches bee-js Stamper implementation.
 *
 * @param chunkAddress - The chunk's content address (32 bytes)
 * @returns Bucket index (0-65535)
 */
export function toBucket(chunkAddress: Uint8Array): number {
  if (chunkAddress.length < 2) {
    throw new Error("Chunk address must be at least 2 bytes")
  }

  // First 2 bytes as big-endian uint16
  return (chunkAddress[0] << 8) | chunkAddress[1]
}

// ============================================================================
// Chunk Mapping for Swarm Storage
// ============================================================================

/**
 * Calculate which utilization chunk a bucket belongs to.
 *
 * @param bucketIndex - Bucket index (0-65535)
 * @param batchDepth - Batch depth, drives the chunk layout
 * @returns Chunk index in the layout for this depth
 */
export function getChunkIndexForBucket(
  bucketIndex: number,
  batchDepth: number,
): number {
  if (bucketIndex < 0 || bucketIndex >= NUM_BUCKETS) {
    throw new Error(
      `Invalid bucket index: ${bucketIndex} (must be 0-${NUM_BUCKETS - 1})`,
    )
  }
  const { bucketsPerChunk } = getChunkLayout(batchDepth)
  return Math.floor(bucketIndex / bucketsPerChunk)
}

/**
 * Extract a CHUNK_SIZE-byte chunk from the dataCounters array using the
 * codec implied by the batch depth.
 *
 * @param dataCounters - Full array of 65,536 counters (kept as Uint32Array
 *   in memory regardless of serialization size)
 * @param chunkIndex - Index of chunk to extract
 * @param batchDepth - Batch depth, drives the chunk layout
 * @returns CHUNK_SIZE byte Uint8Array containing serialized counters
 */
export function extractChunk(
  dataCounters: Uint32Array,
  chunkIndex: number,
  batchDepth: number,
): Uint8Array {
  const { counterByteSize, bucketsPerChunk, numUtilizationChunks } =
    getChunkLayout(batchDepth)

  if (chunkIndex < 0 || chunkIndex >= numUtilizationChunks) {
    throw new Error(
      `Invalid chunk index: ${chunkIndex} (must be 0-${numUtilizationChunks - 1})`,
    )
  }

  const startBucket = chunkIndex * bucketsPerChunk
  const endBucket = startBucket + bucketsPerChunk
  const chunkCounters = dataCounters.slice(startBucket, endBucket)

  return counterByteSize === COUNTER_BYTES_UINT16
    ? serializeUint16Array(chunkCounters)
    : serializeUint32Array(chunkCounters)
}

/**
 * Merge a CHUNK_SIZE-byte chunk back into the dataCounters array using the
 * codec implied by the batch depth.
 *
 * @param dataCounters - Full array of 65,536 counters (modified in place)
 * @param chunkIndex - Index of chunk to merge
 * @param chunkData - CHUNK_SIZE byte Uint8Array containing serialized counters
 * @param batchDepth - Batch depth, drives the chunk layout
 */
export function mergeChunk(
  dataCounters: Uint32Array,
  chunkIndex: number,
  chunkData: Uint8Array,
  batchDepth: number,
): void {
  const { counterByteSize, bucketsPerChunk, numUtilizationChunks } =
    getChunkLayout(batchDepth)

  if (chunkIndex < 0 || chunkIndex >= numUtilizationChunks) {
    throw new Error(
      `Invalid chunk index: ${chunkIndex} (must be 0-${numUtilizationChunks - 1})`,
    )
  }

  if (chunkData.length !== CHUNK_SIZE) {
    throw new Error(
      `Invalid chunk data length: ${chunkData.length} (expected ${CHUNK_SIZE})`,
    )
  }

  const chunkCounters =
    counterByteSize === COUNTER_BYTES_UINT16
      ? deserializeUint16Array(chunkData)
      : deserializeUint32Array(chunkData)

  if (chunkCounters.length !== bucketsPerChunk) {
    throw new Error(
      `Invalid chunk counters length: ${chunkCounters.length} (expected ${bucketsPerChunk})`,
    )
  }

  const startBucket = chunkIndex * bucketsPerChunk
  dataCounters.set(chunkCounters, startBucket)
}

// ============================================================================
// Capacity
// ============================================================================

/**
 * Calculate max slots per bucket based on batch depth
 */
export function calculateMaxSlotsPerBucket(batchDepth: number): number {
  return Math.pow(2, batchDepth - BUCKET_DEPTH)
}

/**
 * Check if a bucket has capacity for more chunks.
 *
 * `dataCounter` is the per-partition `j`, so it must be compared against the
 * partition's lane capacity — not the raw slots-per-bucket. Comparing against
 * the latter let `j` run past the lane and only surfaced as a mid-stamp bee-js
 * throw with counters already incremented (#416).
 */
export function hasBucketCapacity(
  dataCounter: number,
  batchDepth: number,
  partitionCount: number = PARTITION_COUNT,
): boolean {
  return dataCounter < partitionCapacity(batchDepth, partitionCount)
}

/**
 * Physical slot index for partition `partition`'s `j`-th data chunk in a
 * bucket: `partitionCount + partition + partitionCount·j`. The first
 * `partitionCount` slots `[0, partitionCount)` are reserved (one per
 * partition, index = partition) for that partition's lock SOC / counter
 * chunk, so data starts at `partitionCount` and the partitions' data lanes
 * interleave without ever colliding. Legacy single-device is `partitionCount
 * = 1, partition = 0` (reserved slot 0, data from slot 1).
 * See docs/Postage-Batch-Partitioning.md.
 */
export function dataSlot(
  partition: number,
  j: number,
  partitionCount: number,
): number {
  return partitionCount + partition + partitionCount * j
}

/**
 * Number of data chunks a single partition may write into one bucket, i.e.
 * the count of distinct `j` values: `floor(slotsPerBucket / partitionCount)
 * - 1` (the `-1` is the partition's reserved slot). Each partition's data
 * lane is independent, so this is the per-partition per-bucket capacity.
 */
export function partitionCapacity(
  batchDepth: number,
  partitionCount: number,
): number {
  const slotsPerBucket = calculateMaxSlotsPerBucket(batchDepth)
  return Math.floor(slotsPerBucket / partitionCount) - 1
}

/**
 * Fewest data chunks a partition's bucket lane must hold for a batch to be
 * worth buying. At 1 the first chunk written to a bucket already fills that
 * lane, so the batch reports 100% used while effectively empty (#538); at 3
 * some bucket fills after ~1 MB of uniformly placed chunks, a drive too small
 * to be worth its purchase (#566). 7 (depth 20) holds ~66 MB.
 */
export const MIN_USABLE_PARTITION_CAPACITY = 4

/**
 * Smallest batch depth with a usable data lane: the first depth whose
 * {@link partitionCapacity} reaches {@link MIN_USABLE_PARTITION_CAPACITY}.
 * Searched rather than written out, so it follows BUCKET_DEPTH,
 * PARTITION_COUNT and the reserved-slot term; capacity doubles with every
 * depth, so the search terminates. With BUCKET_DEPTH 16 and PARTITION_COUNT 2
 * it is 20 — depth 17 has no data slot at all, 18 exactly one, 19 three.
 */
export const MIN_USABLE_BATCH_DEPTH = ((): number => {
  let batchDepth = BUCKET_DEPTH
  while (
    partitionCapacity(batchDepth, PARTITION_COUNT) <
    MIN_USABLE_PARTITION_CAPACITY
  ) {
    batchDepth += 1
  }
  return batchDepth
})()

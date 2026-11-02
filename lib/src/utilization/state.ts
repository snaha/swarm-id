// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Batch Utilization Tracking for Swarm Storage
 *
 * Tracks slot usage for mutable postage batches. Each of the 65,536 buckets
 * has a uint32 in-memory counter (`dataCounters[bucket]`) representing the
 * next free slot. The counter is initialised at `DATA_COUNTER_START` so the
 * first slots of every bucket are reserved as headroom for utilisation
 * chunks that may incidentally land there — utilisation and data chunks
 * share the same slot space.
 */

import { type Stamper, BatchId, type Bee } from "@ethersphere/bee-js"
import type { ContentAddressedChunk } from "../chunk"
import { Binary } from "cafe-utility"
import type { UtilizationStoreDB } from "../storage/utilization-store"
import {
  NUM_BUCKETS,
  PARTITION_COUNT,
  extractChunk,
  getChunkIndexForBucket,
  getChunkLayout,
  hasBucketCapacity,
  mergeChunk,
  partitionCapacity,
  toBucket,
} from "./layout"
import {
  chooseUtilizationChunkKey,
  claimedBucketsForCleanChunks,
  uploadUtilizationChunk,
} from "./chunk"
import {
  COUNTER_BYTES_UINT16,
  serializeUint16Array,
  serializeUint32Array,
} from "./codec"

// ============================================================================
// Types
// ============================================================================

/**
 * Metadata for a single utilization chunk
 */
export interface ChunkMetadata {
  /** Chunk index within the depth-dependent layout */
  index: number

  /**
   * Content hash / CAC reference (same thing for content-addressed chunks)
   * Empty string means never uploaded
   */
  contentHash: string

  /** Last upload timestamp */
  lastUpload: number

  /** Whether this chunk needs uploading */
  dirty: boolean

  /**
   * Encryption-key nonce that produced this chunk's `contentHash`. Used as
   * the starting point for the next save's bucket-collision search so
   * unchanged plaintexts reuse the same key (and skip re-upload).
   */
  nonce: number
}

/**
 * Utilization state for a postage batch
 *
 * Utilization data is stored as 32 chunks (uint16 codec, depth ≤ 31) or
 * 64 chunks (uint32 codec, depth ≥ 32) on Swarm, with IndexedDB caching
 * for performance.
 */
export interface BatchUtilizationState {
  /** Batch ID this state belongs to */
  batchId: BatchId

  /** Batch depth — determines on-disk chunk layout (uint16 vs uint32) */
  batchDepth: number

  /**
   * Per-partition local counter (65,536 entries) — the 0-based `j` in
   * `slot = partitionCount + partition + partitionCount·j` for the partition
   * this state represents (partition 0 in single-device mode). This is the
   * single counter of record: slot selection, persistence, reporting, and
   * cross-device handoff all derive from it. Always uint32 in memory
   * regardless of the on-disk codec; narrowing happens at the serialize
   * boundary.
   */
  dataCounters: Uint32Array // [65536]

  /** Metadata for each utilization chunk (32 for uint16, 64 for uint32) */
  chunks: ChunkMetadata[]

  /** Last sync timestamp */
  lastSync: number
}

// ============================================================================
// Dirty Chunk Tracking
// ============================================================================

/**
 * Tracks which utilization chunks have been modified and need uploading
 */
export class DirtyChunkTracker {
  private dirtyChunks: Set<number>
  private batchDepth: number

  constructor(batchDepth: number) {
    this.dirtyChunks = new Set()
    this.batchDepth = batchDepth
  }

  /**
   * Mark a bucket as dirty (marks its containing chunk)
   * @param bucketIndex - Bucket index (0-65535)
   */
  markDirty(bucketIndex: number): void {
    const chunkIndex = getChunkIndexForBucket(bucketIndex, this.batchDepth)
    this.dirtyChunks.add(chunkIndex)
  }

  /**
   * Mark a chunk as clean (uploaded successfully)
   * @param chunkIndex - Chunk index
   */
  markClean(chunkIndex: number): void {
    this.dirtyChunks.delete(chunkIndex)
  }

  /**
   * Get array of dirty chunk indices
   * @returns Sorted array of chunk indices that need uploading
   */
  getDirtyChunks(): number[] {
    return Array.from(this.dirtyChunks).sort((a, b) => a - b)
  }

  /**
   * Check if there are any dirty chunks
   * @returns true if there are chunks waiting to be uploaded
   */
  hasDirtyChunks(): boolean {
    return this.dirtyChunks.size > 0
  }

  /**
   * Clear all dirty markers
   */
  clear(): void {
    this.dirtyChunks.clear()
  }

  /**
   * Get number of dirty chunks
   * @returns Count of chunks waiting to be uploaded
   */
  get count(): number {
    return this.dirtyChunks.size
  }
}

// ============================================================================
// Utilization State Management
// ============================================================================

/**
 * Initialize a new batch utilization state
 *
 * Seeds `dataCounters[bucket]` at `DATA_COUNTER_START` for every bucket so
 * the first stamping operations naturally skip the headroom slots.
 *
 * With 65,536 buckets and ~32–64 utilization chunks per save, the
 * probability of any bucket getting 3+ utilisation chunks in one save is
 * < 10⁻⁷, so a headroom of 2 leaves ample margin.
 */
export function initializeBatchUtilization(
  batchId: BatchId,
  batchDepth: number,
): BatchUtilizationState {
  // Per-partition local counter `j`, 0-based. Slot = partitionCount +
  // partition + partitionCount·j, so j=0 maps to the first data slot above
  // the reserved range; no headroom offset is baked into the counter itself.
  const dataCounters = new Uint32Array(NUM_BUCKETS)

  const { numUtilizationChunks } = getChunkLayout(batchDepth)

  // Initialize metadata for all utilization chunks
  const chunks: ChunkMetadata[] = []
  for (let i = 0; i < numUtilizationChunks; i++) {
    chunks.push({
      index: i,
      contentHash: "", // Will be set on first upload
      lastUpload: 0, // Never uploaded
      dirty: true, // Mark as dirty for initial upload
      nonce: 0,
    })
  }

  return {
    batchId,
    batchDepth,
    dataCounters,
    chunks,
    lastSync: Date.now(),
  }
}

// ============================================================================
// Storage Operations (Async with Cache Hierarchy)
// ============================================================================

/**
 * Load utilization state with cache hierarchy
 *
 * Load order:
 * 1. Try IndexedDB cache (all chunks for the depth's layout)
 * 2. If a bucket has no cached chunk, seed it with a zeroed default
 * 3. If nothing is cached, initialize new state
 *
 * The on-Swarm counter is resumed via the partition-state feed (see
 * `sync/partition-state.ts`), not here — this only reads the local cache.
 *
 * @param batchId - Batch ID
 * @param options - Load options (local IndexedDB cache)
 * @returns Utilization state
 */
export async function loadUtilizationState(
  batchId: BatchId,
  batchDepth: number,
  options: {
    cache: UtilizationStoreDB
  },
): Promise<BatchUtilizationState> {
  const { cache } = options

  const { counterByteSize, bucketsPerChunk, numUtilizationChunks } =
    getChunkLayout(batchDepth)

  // Step 1: Try loading from IndexedDB cache
  const cachedChunks = await cache.getAllChunks(batchId.toHex())

  // Step 2: If we have all chunks in cache, reconstruct state
  if (cachedChunks.length === numUtilizationChunks) {
    try {
      const dataCounters = new Uint32Array(NUM_BUCKETS)
      const chunks: ChunkMetadata[] = []

      // Reconstruct dataCounters from cached chunks
      for (const cached of cachedChunks) {
        mergeChunk(dataCounters, cached.chunkIndex, cached.data, batchDepth)

        chunks.push({
          index: cached.chunkIndex,
          contentHash: cached.contentHash,
          lastUpload: cached.lastAccess, // Use lastAccess as lastUpload
          dirty: false, // Not dirty if loaded from cache
          nonce: cached.nonce,
        })
      }

      return {
        batchId,
        batchDepth,
        dataCounters,
        chunks,
        lastSync: Date.now(),
      }
    } catch (error) {
      console.warn(`[BatchUtil] Failed to reconstruct from cache:`, error)
      // Fall through to per-chunk seeding below.
    }
  }

  // Step 2: Seed any bucket without a cached chunk with a zeroed default.

  const dataCounters = new Uint32Array(NUM_BUCKETS)
  const chunks: ChunkMetadata[] = []

  // Seed a default chunk's worth of counters once; reused via mergeChunk.
  // The per-partition counter is 0-based `j`, so a never-written bucket
  // starts at 0.
  const defaultCounters = new Uint32Array(bucketsPerChunk)
  const defaultChunkData =
    counterByteSize === COUNTER_BYTES_UINT16
      ? serializeUint16Array(defaultCounters)
      : serializeUint32Array(defaultCounters)

  for (let i = 0; i < numUtilizationChunks; i++) {
    // Check if we have this chunk in cache
    const cached = cachedChunks.find((c) => c.chunkIndex === i)

    if (cached) {
      // Use cached chunk
      mergeChunk(dataCounters, i, cached.data, batchDepth)

      chunks.push({
        index: i,
        contentHash: cached.contentHash,
        lastUpload: cached.lastAccess,
        dirty: false,
        nonce: cached.nonce,
      })
      continue
    }

    // No cached chunk for this bucket range — seed a zeroed default.
    mergeChunk(dataCounters, i, defaultChunkData, batchDepth)

    chunks.push({
      index: i,
      contentHash: "", // Will be set on first upload
      lastUpload: 0,
      dirty: true, // Mark as dirty for upload
      nonce: 0,
    })
  }

  return {
    batchId,
    batchDepth,
    dataCounters,
    chunks,
    lastSync: Date.now(),
  }
}

/**
 * A stamper that routes utilisation chunks to a reserved slot instead of a
 * data slot, given each chunk's address before it is stamped.
 */
export interface UtilizationChunkReserver {
  markReservedUtilizationChunk(address: Uint8Array, slot?: number): void
  clearReservedUtilizationChunks(): void
}

function reservesUtilizationChunks(
  stamper: Stamper,
): stamper is Stamper & UtilizationChunkReserver {
  return (
    "markReservedUtilizationChunk" in stamper &&
    "clearReservedUtilizationChunks" in stamper
  )
}

/**
 * Save utilization state with incremental upload
 *
 * Only uploads dirty chunks to minimize network traffic.
 * Updates IndexedDB cache with new chunk data.
 *
 * @param state - Current utilization state (modified in place)
 * @param options - Save options
 */
export async function saveUtilizationState(
  state: BatchUtilizationState,
  options: {
    bee: Bee
    stamper: Stamper
    encryptionKey: Uint8Array
    cache: UtilizationStoreDB
    tracker: DirtyChunkTracker
    reservedBuckets?: ReadonlySet<number>
  },
): Promise<void> {
  const { bee, stamper, encryptionKey, cache, tracker, reservedBuckets } =
    options

  // Get dirty chunks from tracker
  const dirtyChunkIndices = tracker.getDirtyChunks()

  if (dirtyChunkIndices.length === 0) {
    return
  }

  // Treat the buckets currently occupied by clean utilisation chunks as
  // already claimed — dirty chunks must avoid them so utilisation chunks
  // land in distinct buckets within a save. Also avoid `reservedBuckets`
  // (e.g. per-partition lock SOCs) so utilisation chunks don't land on a
  // slot the lock SOC overstamps every refresh.
  const claimedBuckets = claimedBucketsForCleanChunks(state)
  if (reservedBuckets) {
    for (const bucket of reservedBuckets) {
      claimedBuckets.add(bucket)
    }
  }

  // Counter chunks overstamp this partition's reserved slot rather than a data
  // slot (see `UtilizationAwareStamper.stamp`). Their addresses are
  // content-derived, so register each before uploading and clear them after.
  const reserver = reservesUtilizationChunks(stamper) ? stamper : undefined

  for (const chunkIndex of dirtyChunkIndices) {
    const chunkMetadata = state.chunks[chunkIndex]

    // Extract chunk data from dataCounters
    const chunkData = extractChunk(
      state.dataCounters,
      chunkIndex,
      state.batchDepth,
    )

    // Search for a derived key whose bucket isn't already claimed. Start
    // from the previously-chosen nonce so unchanged plaintexts reuse their
    // key (and skip upload via dedup below).
    const resolved = await chooseUtilizationChunkKey({
      swarmEncryptionKey: encryptionKey,
      batchId: state.batchId,
      chunkIndex,
      plaintext: chunkData,
      priorNonce: chunkMetadata.nonce,
      claimedBuckets,
    })

    reserver?.markReservedUtilizationChunk(resolved.address)

    try {
      // Upload to Swarm as encrypted CAC with the per-chunk derived key
      const cacReference = await uploadUtilizationChunk(
        bee,
        stamper,
        chunkData,
        resolved.key,
      )

      const cacReferenceHex = Binary.uint8ArrayToHex(cacReference)

      // Skip if reference unchanged (deduplication)
      if (
        chunkMetadata.contentHash === cacReferenceHex &&
        chunkMetadata.nonce === resolved.nonce
      ) {
        tracker.markClean(chunkIndex)
        continue
      }

      // Update metadata
      chunkMetadata.contentHash = cacReferenceHex
      chunkMetadata.lastUpload = Date.now()
      chunkMetadata.dirty = false
      chunkMetadata.nonce = resolved.nonce

      // Update IndexedDB cache
      await cache.putChunk({
        batchId: state.batchId.toHex(),
        chunkIndex,
        data: chunkData,
        contentHash: cacReferenceHex,
        nonce: resolved.nonce,
        lastAccess: Date.now(),
      })

      // Mark chunk as clean
      tracker.markClean(chunkIndex)
    } catch (error) {
      console.error(`[BatchUtil] Failed to upload chunk ${chunkIndex}:`, error)
      reserver?.clearReservedUtilizationChunks()
      // Keep it marked as dirty for retry
      throw error
    }
  }

  reserver?.clearReservedUtilizationChunks()

  // Update lastSync timestamp
  state.lastSync = Date.now()
}

// ============================================================================
// High-level API
// ============================================================================

/**
 * Update utilization state after writing data chunks
 *
 * This function:
 * 1. Loads current state from the local cache
 * 2. Updates bucket counters for new data chunks
 * 3. Marks affected utilization chunks as dirty
 * 4. Returns state and tracker for later upload
 *
 * @param batchId - Batch ID
 * @param dataChunks - Data chunks that were written
 * @param batchDepth - Batch depth parameter
 * @param options - Load options (local IndexedDB cache)
 * @returns Updated state and dirty chunk tracker
 */
export async function updateAfterWrite(
  batchId: BatchId,
  dataChunks: ContentAddressedChunk[],
  batchDepth: number,
  options: {
    cache: UtilizationStoreDB
  },
): Promise<{
  state: BatchUtilizationState
  tracker: DirtyChunkTracker
}> {
  // Load current state
  const state = await loadUtilizationState(batchId, batchDepth, options)

  // Create tracker for dirty chunks
  const tracker = new DirtyChunkTracker(batchDepth)

  // Assign buckets and slots to data chunks
  for (const chunk of dataChunks) {
    const bucket = toBucket(chunk.address.toUint8Array())
    const slot = state.dataCounters[bucket]

    // Check capacity
    if (!hasBucketCapacity(slot, batchDepth)) {
      throw new Error(`Bucket ${bucket} is full (slot ${slot})`)
    }

    // Increment counter
    state.dataCounters[bucket]++

    // Mark the utilization chunk containing this bucket as dirty
    tracker.markDirty(bucket)
  }

  // Log dirty chunks
  const dirtyChunks = tracker.getDirtyChunks()

  // Mark chunks as dirty in state metadata
  for (const chunkIndex of dirtyChunks) {
    state.chunks[chunkIndex].dirty = true
  }

  return {
    state,
    tracker,
  }
}

/**
 * Calculate current utilization fraction for a batch
 *
 * @param state - Current utilization state
 * @param batchDepth - Batch depth parameter
 * @returns Utilization as decimal fraction (0-1)
 */
export function calculateUtilization(
  state: BatchUtilizationState,
  batchDepth: number,
  partitionCount: number = PARTITION_COUNT,
): number {
  // dataCounters holds the per-partition 0-based `j`. A partition is full
  // when `j` reaches its per-partition capacity, so fill is measured against
  // that, not the raw slot count.
  const capacity = partitionCapacity(batchDepth, partitionCount)
  // `dataCounters` has NUM_BUCKETS (65,536) entries — spreading it into
  // Math.max(...) would blow the argument-count limit, so scan with a loop.
  let maxBucketUsage = 0
  for (const count of state.dataCounters) {
    if (count > maxBucketUsage) maxBucketUsage = count
  }

  // Utilization is based on the fullest bucket within the partition's lane.
  return capacity <= 0 ? 1 : Math.min(1, maxBucketUsage / capacity)
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Batch Utilization Tracking for Swarm Storage
 *
 * This module implements utilization tracking for mutable postage batches.
 * It manages two counter arrays:
 * - Utilization counters (local, uint8): Track slots 0-255 per bucket for utilization chunks
 * - Data counters (on-chain, uint32): Track slots 256+ per bucket for data chunks
 *
 * The system uses pre-calculation to handle the circular dependency of storing
 * utilization data that tracks the storage of itself.
 */

import {
  Stamper,
  BatchId,
  Topic,
  Identifier,
  type Bee,
  EthAddress,
  type EnvelopeWithBatchId,
} from "@ethersphere/bee-js"
import {
  makeEncryptedContentAddressedChunk,
  makeContentAddressedChunk,
  type ContentAddressedChunk,
} from "../chunk"
import { Binary, type Chunk as CafeChunk } from "cafe-utility"
import type { UtilizationStoreDB } from "../storage/utilization-store"
import { uploadData, type UploadTarget } from "../proxy/upload"
import { tryCreateTag } from "./tag"

// ============================================================================
// Constants
// ============================================================================

/** Number of buckets in a postage batch (2^16) */
export const NUM_BUCKETS = 65536

/** Bucket depth parameter (determines bucket count) */
export const BUCKET_DEPTH = 16

/** Number of slots reserved per bucket for utilization chunks (0-3) */
export const UTILIZATION_SLOTS_PER_BUCKET = 4

/** Starting slot index for data chunks */
export const DATA_COUNTER_START = 4

/** Size of each chunk in bytes */
export const CHUNK_SIZE = 4096

/** Batch depth for N=256 slots per bucket with 65536 buckets */
export const DEFAULT_BATCH_DEPTH = 24

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

/** uint16 serialization size in bytes */
const COUNTER_BYTES_UINT16 = 2

/** uint32 serialization size in bytes */
const COUNTER_BYTES_UINT32 = 4

/** Largest value representable in an unsigned 16-bit integer */
const UINT16_MAX = 0xffff

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
   * Data counters (65,536 entries). Always uint32 in memory regardless of
   * the on-disk codec; narrowing happens at the serialize boundary.
   */
  dataCounters: Uint32Array // [65536]

  /** Metadata for each utilization chunk (32 for uint16, 64 for uint32) */
  chunks: ChunkMetadata[]

  /** Topic for SOC storage */
  topic: Topic

  /** Last sync timestamp */
  lastSync: number
}

/**
 * Chunk with bucket assignment
 */
export interface ChunkWithBucket {
  chunk: ContentAddressedChunk
  bucket: number
  slot: number
}

/**
 * Result of calculating utilization update
 */
export interface UtilizationUpdate {
  /** Updated data counters */
  dataCounters: Uint32Array

  /** Utilization chunks to upload */
  utilizationChunks: ChunkWithBucket[]
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

/**
 * Calculate bucket assignments for multiple chunks
 */
export function assignChunksToBuckets(
  chunks: ContentAddressedChunk[],
): ChunkWithBucket[] {
  return chunks.map((chunk) => {
    const address = chunk.address.toUint8Array()
    const bucket = toBucket(address)

    return {
      chunk,
      bucket,
      slot: 0, // Will be assigned later
    }
  })
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
// SOC Identifier Generation for Swarm Storage
// ============================================================================

/**
 * Create a topic for batch utilization storage
 * Topic format: `batch-utilization:{batchId}`
 *
 * @param batchId - Batch ID
 * @returns Topic for this batch's utilization data
 */
export function makeBatchUtilizationTopic(batchId: BatchId): Topic {
  const topicString = `batch-utilization:${batchId.toHex()}`
  const encoder = new TextEncoder()
  const hash = Binary.keccak256(encoder.encode(topicString))
  return new Topic(hash)
}

/**
 * Create an identifier for a specific utilization chunk
 * Identifier: Keccak256(topic || chunkIndex)
 *
 * @param topic - Batch utilization topic
 * @param chunkIndex - Chunk index
 * @param batchDepth - Batch depth, drives the chunk count
 * @returns Identifier for this chunk
 */
export function makeChunkIdentifier(
  topic: Topic,
  chunkIndex: number,
  batchDepth: number,
): Identifier {
  const { numUtilizationChunks } = getChunkLayout(batchDepth)
  if (chunkIndex < 0 || chunkIndex >= numUtilizationChunks) {
    throw new Error(
      `Invalid chunk index: ${chunkIndex} (must be 0-${numUtilizationChunks - 1})`,
    )
  }

  // Encode chunk index as 32-bit big-endian
  const chunkIndexBytes = new Uint8Array(4)
  const view = new DataView(chunkIndexBytes.buffer)
  view.setUint32(0, chunkIndex, false) // false = big-endian

  // Hash: topic || chunkIndex
  const hash = Binary.keccak256(
    Binary.concatBytes(topic.toUint8Array(), chunkIndexBytes),
  )

  return new Identifier(hash)
}

// ============================================================================
// Chunk Upload/Download for Swarm Storage
// ============================================================================

/**
 * Upload an encrypted utilization chunk to Swarm as CAC
 *
 * Architecture: Just upload encrypted chunk data as CAC (immutable)
 *
 * @param bee - Bee client instance
 * @param stamper - Stamper for signing
 * @param chunkIndex - Chunk index
 * @param data - Chunk data to upload (4KB)
 * @param encryptionKey - Encryption key (32 bytes)
 * @returns CAC reference
 */
export async function uploadUtilizationChunk(
  bee: Bee,
  stamper: Stamper,
  chunkIndex: number,
  data: Uint8Array,
  encryptionKey: Uint8Array,
): Promise<Uint8Array> {
  void chunkIndex // Parameter kept for API compatibility

  // Validate inputs
  if (data.length < 1 || data.length > 4096) {
    throw new Error(`Invalid data length: ${data.length} (expected 1-4096)`)
  }
  if (encryptionKey.length !== 32) {
    throw new Error(
      `Invalid encryption key length: ${encryptionKey.length} (expected 32)`,
    )
  }

  // Calculate CAC reference first (before upload)
  const encryptedChunk = makeEncryptedContentAddressedChunk(data, encryptionKey)
  const cacReference = encryptedChunk.address.toUint8Array()

  const tag = await tryCreateTag(bee)

  const target: UploadTarget = {
    mode: "stamper",
    bee,
    stamper,
  }

  // Upload using unified interface (with deferred: false for fast return)
  await uploadData(target, data, {
    encryptionKey,
    deferred: false,
    tag,
  })

  return cacReference
}

/**
 * Download and decrypt a utilization chunk from Swarm by CAC reference
 *
 * @param bee - Bee client instance
 * @param cacReference - CAC reference (32 bytes)
 * @param chunkIndex - Chunk index (for logging)
 * @param encryptionKey - Encryption key (32 bytes)
 * @returns Decrypted chunk data (4KB) or undefined if not found
 */
export async function downloadUtilizationChunk(
  bee: Bee,
  cacReference: Uint8Array,
  chunkIndex: number,
  encryptionKey: Uint8Array,
): Promise<Uint8Array | undefined> {
  if (encryptionKey.length !== 32) {
    throw new Error(
      `Invalid encryption key length: ${encryptionKey.length} (expected 32)`,
    )
  }

  if (cacReference.length !== 32) {
    throw new Error(
      `Invalid CAC reference length: ${cacReference.length} (expected 32)`,
    )
  }

  try {
    // Download encrypted CAC from Swarm
    const cacUrl = `${bee.url}/chunks/${Binary.uint8ArrayToHex(cacReference)}`

    const cacResponse = await fetch(cacUrl, {
      method: "GET",
    })

    if (cacResponse.status === 404) {
      console.warn(
        `[UtilChunk] CAC not found for chunk ${chunkIndex} (reference: ${Binary.uint8ArrayToHex(cacReference).substring(0, 16)}...)`,
      )
      return undefined
    }

    if (!cacResponse.ok) {
      const text = await cacResponse.text()
      throw new Error(
        `Failed to download CAC: ${cacResponse.status} ${cacResponse.statusText}: ${text}`,
      )
    }

    // Get the encrypted CAC data
    void (await cacResponse.arrayBuffer())

    // Decrypt the CAC data
    // TODO: Implement decryption
    // For now, this is a placeholder
    throw new Error(
      "Decryption not yet implemented - need to add decryptChunk function",
    )
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Decryption not yet implemented")
    ) {
      throw error
    }
    return undefined
  }
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serialize Uint32Array to bytes (little-endian)
 */
export function serializeUint32Array(arr: Uint32Array): Uint8Array {
  const buffer = new ArrayBuffer(arr.length * 4)
  const view = new DataView(buffer)

  for (let i = 0; i < arr.length; i++) {
    view.setUint32(i * 4, arr[i], true) // true = little-endian
  }

  return new Uint8Array(buffer)
}

/**
 * Deserialize bytes to Uint32Array (little-endian)
 */
export function deserializeUint32Array(bytes: Uint8Array): Uint32Array {
  if (bytes.length % 4 !== 0) {
    throw new Error("Byte array length must be a multiple of 4")
  }

  const arr = new Uint32Array(bytes.length / 4)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  for (let i = 0; i < arr.length; i++) {
    arr[i] = view.getUint32(i * 4, true) // true = little-endian
  }

  return arr
}

/**
 * Serialize a Uint32Array to bytes as little-endian uint16 values.
 *
 * Counters exceeding uint16 throw — callers must use the uint32 codec
 * (i.e. batchDepth >= UINT16_COUNTER_MAX_DEPTH + 1) for those depths.
 */
export function serializeUint16Array(arr: Uint32Array): Uint8Array {
  const buffer = new ArrayBuffer(arr.length * COUNTER_BYTES_UINT16)
  const view = new DataView(buffer)

  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]
    if (v > UINT16_MAX) {
      throw new Error(
        `Counter at index ${i} (${v}) exceeds uint16 range; use uint32 codec`,
      )
    }
    view.setUint16(i * COUNTER_BYTES_UINT16, v, true) // true = little-endian
  }

  return new Uint8Array(buffer)
}

/**
 * Deserialize little-endian uint16 bytes back into a Uint32Array (the
 * in-memory representation stays uint32 even when the on-disk codec is
 * narrower).
 */
export function deserializeUint16Array(bytes: Uint8Array): Uint32Array {
  if (bytes.length % COUNTER_BYTES_UINT16 !== 0) {
    throw new Error("Byte array length must be a multiple of 2")
  }

  const arr = new Uint32Array(bytes.length / COUNTER_BYTES_UINT16)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  for (let i = 0; i < arr.length; i++) {
    arr[i] = view.getUint16(i * COUNTER_BYTES_UINT16, true) // true = little-endian
  }

  return arr
}

/**
 * Split data into 4KB chunks
 */
export function splitIntoChunks(data: Uint8Array): ContentAddressedChunk[] {
  const chunks: ContentAddressedChunk[] = []

  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, data.length)
    const chunkData = data.slice(i, end)

    // Pad last chunk if needed
    const paddedData = new Uint8Array(CHUNK_SIZE)
    paddedData.set(chunkData)

    chunks.push(makeContentAddressedChunk(paddedData))
  }

  return chunks
}

/**
 * Reconstruct data from chunks
 */
export function reconstructFromChunks(
  chunks: ContentAddressedChunk[],
  originalLength: number,
): Uint8Array {
  const result = new Uint8Array(originalLength)
  let offset = 0

  for (const chunk of chunks) {
    const data = chunk.data
    const copyLength = Math.min(data.length, originalLength - offset)
    result.set(data.slice(0, copyLength), offset)
    offset += copyLength

    if (offset >= originalLength) break
  }

  return result
}

// ============================================================================
// Utilization State Management
// ============================================================================

/**
 * Initialize a new batch utilization state
 *
 * Reserves slots 0-3 per bucket for utilization metadata chunks,
 * and starts data chunks at slot 4 (DATA_COUNTER_START).
 *
 * With 65,536 buckets and ~64 utilization chunks, the probability
 * of any bucket getting 4+ utilization chunks is negligible (< 0.0000001%).
 */
export function initializeBatchUtilization(
  batchId: BatchId,
  batchDepth: number,
): BatchUtilizationState {
  const dataCounters = new Uint32Array(NUM_BUCKETS)

  // Initialize data counters to start at slot 4
  // Slots 0-3 are reserved for utilization metadata chunks
  dataCounters.fill(DATA_COUNTER_START)

  const { numUtilizationChunks } = getChunkLayout(batchDepth)

  // Initialize metadata for all utilization chunks
  const chunks: ChunkMetadata[] = []
  for (let i = 0; i < numUtilizationChunks; i++) {
    chunks.push({
      index: i,
      contentHash: "", // Will be set on first upload
      lastUpload: 0, // Never uploaded
      dirty: true, // Mark as dirty for initial upload
    })
  }

  // Create topic for this batch
  const topic = makeBatchUtilizationTopic(batchId)

  return {
    batchId,
    batchDepth,
    dataCounters,
    chunks,
    topic,
    lastSync: Date.now(),
  }
}

/**
 * Calculate max slots per bucket based on batch depth
 */
export function calculateMaxSlotsPerBucket(batchDepth: number): number {
  return Math.pow(2, batchDepth - BUCKET_DEPTH)
}

/**
 * Check if a bucket has capacity for more chunks
 */
export function hasBucketCapacity(
  dataCounter: number,
  batchDepth: number,
): boolean {
  const maxSlots = calculateMaxSlotsPerBucket(batchDepth)
  return dataCounter < maxSlots
}

// ============================================================================
// Pre-calculation Algorithm
// ============================================================================

/**
 * Pre-calculate utilization update after writing data chunks.
 *
 * This solves the circular dependency problem:
 * 1. Assign buckets/slots to data chunks
 * 2. Update data counters
 * 3. Serialize data counters into utilization chunks
 * 4. Calculate where utilization chunks will land
 * 5. Assign slots 0-N to utilization chunks per bucket
 *
 * Note: Utilization chunks always start from slot 0 since mutable stamps
 * allow overwriting. No need to track previous positions.
 *
 * @param state - Current utilization state
 * @param dataChunks - Data chunks to be written
 * @param batchDepth - Batch depth parameter
 * @returns Updated state and utilization chunks to upload
 */
export function calculateUtilizationUpdate(
  state: BatchUtilizationState,
  dataChunks: ContentAddressedChunk[],
  batchDepth: number,
): UtilizationUpdate {
  // Step 1: Copy current data counters (immutable update)
  const newDataCounters = new Uint32Array(state.dataCounters)

  // Step 2: Assign buckets and slots to data chunks
  const dataChunksWithBuckets: ChunkWithBucket[] = []

  for (const chunk of dataChunks) {
    const bucket = toBucket(chunk.address.toUint8Array())
    const slot = newDataCounters[bucket]

    // Check capacity
    if (!hasBucketCapacity(slot, batchDepth)) {
      throw new Error(`Bucket ${bucket} is full (slot ${slot})`)
    }

    dataChunksWithBuckets.push({ chunk, bucket, slot })
    newDataCounters[bucket]++
  }

  // Step 3: Serialize updated data counters using the codec for this depth
  const { counterByteSize } = getChunkLayout(batchDepth)
  const serialized =
    counterByteSize === COUNTER_BYTES_UINT16
      ? serializeUint16Array(newDataCounters)
      : serializeUint32Array(newDataCounters)
  const utilizationChunksRaw = splitIntoChunks(serialized)

  // Step 4: Calculate bucket assignments for utilization chunks
  // Count chunks per bucket for THIS update only (start from 0)
  const bucketChunkCount = new Uint32Array(NUM_BUCKETS)
  const utilizationChunks: ChunkWithBucket[] = []

  for (const chunk of utilizationChunksRaw) {
    const bucket = toBucket(chunk.address.toUint8Array())
    const slot = bucketChunkCount[bucket] // Start from 0 each time

    utilizationChunks.push({ chunk, bucket, slot })
    bucketChunkCount[bucket]++
  }

  return {
    dataCounters: newDataCounters,
    utilizationChunks,
  }
}

// ============================================================================
// Stamper Integration
// ============================================================================

/**
 * Create a Stamper with custom bucket state for mutable stamping
 *
 * @param privateKey - Private key for signing
 * @param batchId - Batch ID
 * @param bucketState - Custom bucket heights (for resuming or mutable overwrites)
 * @param batchDepth - Batch depth parameter
 */
export function createStamper(
  privateKey: Uint8Array | string,
  batchId: BatchId,
  bucketState: Uint32Array,
  batchDepth: number,
): Stamper {
  return Stamper.fromState(privateKey, batchId, bucketState, batchDepth)
}

/**
 * Prepare bucket state for stamping chunks with specific slots
 *
 * @param chunksWithBuckets - Chunks with assigned buckets and slots
 * @returns Bucket state array for Stamper
 */
export function prepareBucketState(
  chunksWithBuckets: ChunkWithBucket[],
): Uint32Array {
  const bucketState = new Uint32Array(NUM_BUCKETS)

  // Set each bucket height to the slot we want to write to
  for (const { bucket, slot } of chunksWithBuckets) {
    // Use the highest slot we need for this bucket
    bucketState[bucket] = Math.max(bucketState[bucket], slot)
  }

  return bucketState
}

/**
 * Convert utilization data counters to Stamper bucket state
 *
 * Each dataCounter[bucket] represents the number of slots used in that bucket.
 * The Stamper's bucket state should start at the next available slot.
 *
 * @param dataCounters - Current utilization counters (65536 buckets)
 * @returns Bucket state array for Stamper (65536 entries)
 */
export function utilizationToBucketState(
  dataCounters: Uint32Array,
): Uint32Array {
  const bucketState = new Uint32Array(NUM_BUCKETS)

  for (let bucket = 0; bucket < NUM_BUCKETS; bucket++) {
    // Each counter represents slots used
    // Stamper should start at the next slot
    bucketState[bucket] = dataCounters[bucket]
  }

  return bucketState
}

// ============================================================================
// Storage Operations (Async with Cache Hierarchy)
// ============================================================================

/**
 * Load utilization state with cache hierarchy
 *
 * Load order:
 * 1. Try IndexedDB cache (all chunks for the depth's layout)
 * 2. If incomplete, download missing chunks from Swarm
 * 3. If not found, initialize new state
 * 4. Cache downloaded chunks in IndexedDB
 *
 * @param batchId - Batch ID
 * @param options - Load options with bee, owner, encryption key, and cache
 * @returns Utilization state
 */
export async function loadUtilizationState(
  batchId: BatchId,
  batchDepth: number,
  options: {
    bee: Bee
    owner: EthAddress
    encryptionKey: Uint8Array
    cache: UtilizationStoreDB
  },
): Promise<BatchUtilizationState> {
  const { cache } = options
  // TODO: Use bee, owner, encryptionKey when state feed is implemented
  const { bee: _bee, owner: _owner, encryptionKey: _encryptionKey } = options

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
        })
      }

      const topic = makeBatchUtilizationTopic(batchId)

      return {
        batchId,
        batchDepth,
        dataCounters,
        chunks,
        topic,
        lastSync: Date.now(),
      }
    } catch (error) {
      console.warn(`[BatchUtil] Failed to reconstruct from cache:`, error)
      // Fall through to Swarm download
    }
  }

  // Step 3: Download missing chunks from Swarm

  const dataCounters = new Uint32Array(NUM_BUCKETS)
  const chunks: ChunkMetadata[] = []

  // Seed a default chunk's worth of counters once; reused via mergeChunk
  const defaultCounters = new Uint32Array(bucketsPerChunk)
  defaultCounters.fill(DATA_COUNTER_START)
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
      })
      continue
    }

    // TODO: Download from Swarm using state feed (not yet implemented)
    // For now, initialize with defaults
    mergeChunk(dataCounters, i, defaultChunkData, batchDepth)

    chunks.push({
      index: i,
      contentHash: "", // Will be set on first upload
      lastUpload: 0,
      dirty: true, // Mark as dirty for upload
    })
  }

  const topic = makeBatchUtilizationTopic(batchId)

  return {
    batchId,
    batchDepth,
    dataCounters,
    chunks,
    topic,
    lastSync: Date.now(),
  }
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
  },
): Promise<void> {
  const { bee, stamper, encryptionKey, cache, tracker } = options

  // Get dirty chunks from tracker
  const dirtyChunkIndices = tracker.getDirtyChunks()

  if (dirtyChunkIndices.length === 0) {
    return
  }

  for (const chunkIndex of dirtyChunkIndices) {
    const chunkMetadata = state.chunks[chunkIndex]

    // Extract chunk data from dataCounters
    const chunkData = extractChunk(
      state.dataCounters,
      chunkIndex,
      state.batchDepth,
    )

    try {
      // Upload to Swarm as encrypted CAC
      const cacReference = await uploadUtilizationChunk(
        bee,
        stamper,
        chunkIndex,
        chunkData,
        encryptionKey,
      )

      const cacReferenceHex = Binary.uint8ArrayToHex(cacReference)

      // Skip if reference unchanged (deduplication)
      if (chunkMetadata.contentHash === cacReferenceHex) {
        tracker.markClean(chunkIndex)
        continue
      }

      // Update metadata
      chunkMetadata.contentHash = cacReferenceHex
      chunkMetadata.lastUpload = Date.now()
      chunkMetadata.dirty = false

      // Update IndexedDB cache
      await cache.putChunk({
        batchId: state.batchId.toHex(),
        chunkIndex,
        data: chunkData,
        contentHash: cacReferenceHex,
        lastAccess: Date.now(),
      })

      // Mark chunk as clean
      tracker.markClean(chunkIndex)
    } catch (error) {
      console.error(`[BatchUtil] Failed to upload chunk ${chunkIndex}:`, error)
      // Keep it marked as dirty for retry
      throw error
    }
  }

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
 * 1. Loads current state (from cache or Swarm)
 * 2. Updates bucket counters for new data chunks
 * 3. Marks affected utilization chunks as dirty
 * 4. Returns state and tracker for later upload
 *
 * @param batchId - Batch ID
 * @param dataChunks - Data chunks that were written
 * @param batchDepth - Batch depth parameter
 * @param options - Load options for state retrieval
 * @returns Updated state and dirty chunk tracker
 */
export async function updateAfterWrite(
  batchId: BatchId,
  dataChunks: ContentAddressedChunk[],
  batchDepth: number,
  options: {
    bee: Bee
    owner: EthAddress
    encryptionKey: Uint8Array
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
): number {
  const maxSlots = calculateMaxSlotsPerBucket(batchDepth)
  const maxBucketUsage = Math.max(...Array.from(state.dataCounters))

  // Utilization is based on the fullest bucket
  return Math.min(1, maxBucketUsage / maxSlots)
}

// ============================================================================
// Utilization-Aware Stamper (Wrapper with Auto-Tracking)
// ============================================================================

/**
 * Stamper wrapper that maintains bucket state from utilization data
 *
 * This class wraps the cafe-utility Stamper and:
 * - Loads bucket state from cached utilization data on creation
 * - Tracks which buckets/slots are used during stamping
 * - Provides a flush() method to persist updates back to cache
 *
 * This ensures the Stamper always has accurate knowledge of which
 * buckets/slots are already used, preventing overwrites.
 */
export class UtilizationAwareStamper implements Stamper {
  private stamper: Stamper
  private utilizationState: BatchUtilizationState
  private cache: UtilizationStoreDB
  private readonly encryptionKey: Uint8Array
  private dirty: boolean = false
  private dirtyBuckets: Set<number> = new Set()

  readonly batchId: BatchId
  readonly depth: number

  // Delegate Stamper properties to underlying stamper
  get signer() {
    return this.stamper.signer
  }
  get buckets() {
    return this.stamper.buckets
  }
  get maxSlot() {
    return this.stamper.maxSlot
  }

  private constructor(
    stamper: Stamper,
    batchId: BatchId,
    depth: number,
    cache: UtilizationStoreDB,
    encryptionKey: Uint8Array,
    utilizationState: BatchUtilizationState,
  ) {
    this.stamper = stamper
    this.batchId = batchId
    this.depth = depth
    this.cache = cache
    this.encryptionKey = encryptionKey
    this.utilizationState = utilizationState
  }

  /**
   * Create a UtilizationAwareStamper with bucket state from cache
   *
   * @param privateKey - Signer private key
   * @param batchId - Postage batch ID
   * @param depth - Batch depth
   * @param cache - Utilization cache database
   * @param _owner - Owner address (required for validation, reserved for future Swarm upload)
   * @param encryptionKey - Encryption key used to compute the canonical Swarm chunk address on local flush. Both call sites already pass the account's encryption key; "anything stable" works for now, will be tied to multi-device collision avoidance later.
   * @returns New UtilizationAwareStamper instance
   */
  static async create(
    privateKey: Uint8Array | string,
    batchId: BatchId,
    depth: number,
    cache: UtilizationStoreDB,
    _owner: EthAddress,
    encryptionKey: Uint8Array,
  ): Promise<UtilizationAwareStamper> {
    // Initialize utilization state (always, since owner is now required)
    const utilizationState = initializeBatchUtilization(batchId, depth)
    let bucketState: Uint32Array

    // Try to load utilization state from cache
    try {
      const cachedChunks = await cache.getAllChunks(batchId.toHex())
      const { numUtilizationChunks } = getChunkLayout(depth)
      // Merge cached chunks into state; ignore any that fall outside the
      // current depth's layout (e.g. stale entries from a different depth)
      for (const cached of cachedChunks) {
        if (cached.chunkIndex >= numUtilizationChunks) continue
        mergeChunk(
          utilizationState.dataCounters,
          cached.chunkIndex,
          cached.data,
          depth,
        )
      }
    } catch (error) {
      console.warn(
        `[UtilizationAwareStamper] Failed to load state from cache, starting with fresh state:`,
        error,
      )
    }

    // Convert utilization counters to bucket state
    bucketState = utilizationToBucketState(utilizationState.dataCounters)

    // Create underlying stamper with bucket state
    const stamper = Stamper.fromState(privateKey, batchId, bucketState, depth)

    return new UtilizationAwareStamper(
      stamper,
      batchId,
      depth,
      cache,
      encryptionKey,
      utilizationState,
    )
  }

  /**
   * Stamp a chunk (implements Stamper interface)
   *
   * Delegates to underlying stamper and tracks which buckets are used.
   *
   * @param chunk - Chunk to stamp
   * @returns Envelope with batch ID and signature
   */
  stamp(chunk: CafeChunk): EnvelopeWithBatchId {
    const envelope = this.stamper.stamp(chunk)

    // Extract bucket from envelope index
    // The index is 8 bytes: first 4 bytes = bucket (big-endian), last 4 bytes = slot
    const view = new DataView(
      envelope.index.buffer,
      envelope.index.byteOffset,
      envelope.index.byteLength,
    )
    const bucket = view.getUint32(0, false) // false = big-endian

    // Update utilization state (increment counter for this bucket)
    this.utilizationState.dataCounters[bucket]++

    // Mark bucket as dirty for eventual flush
    this.dirtyBuckets.add(bucket)
    this.dirty = true

    return envelope
  }

  /**
   * Get bucket state (implements Stamper interface)
   */
  getState(): Uint32Array {
    return this.stamper.getState()
  }

  /**
   * Flush dirty utilization chunks to cache
   *
   * This persists any bucket state changes made during stamping.
   * Should be called after all stamping operations are complete.
   */
  async flush(): Promise<void> {
    if (!this.dirty) {
      return
    }

    // Mark utilization chunks as dirty for the affected buckets
    const dirtyChunkIndexes = new Set<number>()
    for (const bucket of this.dirtyBuckets) {
      const chunkIndex = getChunkIndexForBucket(bucket, this.depth)
      dirtyChunkIndexes.add(chunkIndex)
      this.utilizationState.chunks[chunkIndex].dirty = true
    }

    // Save dirty chunks to cache. We do not upload here, but we still record
    // the contentHash that an upload *would* assign — i.e. the BMT address of
    // the encrypted chunk for this plaintext + encryptionKey. That is what the
    // upload-path dedup at saveUtilizationState compares against, so storing
    // anything else (e.g. keccak of plaintext) would force a redundant
    // re-upload of every flushed chunk on the next sync.
    try {
      for (const chunkIndex of dirtyChunkIndexes) {
        const chunkData = extractChunk(
          this.utilizationState.dataCounters,
          chunkIndex,
          this.depth,
        )

        const encryptedChunk = makeEncryptedContentAddressedChunk(
          chunkData,
          this.encryptionKey,
        )
        const contentHash = Binary.uint8ArrayToHex(
          encryptedChunk.address.toUint8Array(),
        )

        await this.cache.putChunk({
          batchId: this.batchId.toHex(),
          chunkIndex,
          data: chunkData,
          contentHash,
          lastAccess: Date.now(),
        })
        this.utilizationState.chunks[chunkIndex].contentHash = contentHash
        this.utilizationState.chunks[chunkIndex].dirty = false
      }

      // Update lastSync timestamp
      this.utilizationState.lastSync = Date.now()
    } catch (error) {
      console.error(
        `[UtilizationAwareStamper] Failed to flush to cache:`,
        error,
      )
      throw error
    }

    // Clear dirty flags
    this.dirtyBuckets.clear()
    this.dirty = false
  }

  /**
   * Get current utilization state
   *
   * @returns Current utilization state
   */
  getUtilizationState(): BatchUtilizationState {
    return this.utilizationState
  }

  /**
   * Apply utilization update from another tab.
   * Updates local bucket counters to match leader's state.
   *
   * @param buckets Array of bucket indices and their new counter values
   */
  applyUtilizationUpdate(
    buckets: Array<{ index: number; value: number }>,
  ): void {
    for (const { index, value } of buckets) {
      if (index >= 0 && index < NUM_BUCKETS) {
        // Only update if the incoming value is higher (monotonic increase)
        if (value > this.utilizationState.dataCounters[index]) {
          this.utilizationState.dataCounters[index] = value
        }
      }
    }

    // Update stamper bucket state to match
    const bucketState = utilizationToBucketState(
      this.utilizationState.dataCounters,
    )
    this.stamper = Stamper.fromState(
      this.stamper.signer,
      this.batchId,
      bucketState,
      this.depth,
    )

    // Note: Do NOT clear dirtyBuckets here - those represent local writes
    // that still need to be flushed. Only flush() should clear them.
  }

  /**
   * Get bucket counter values for broadcasting to other tabs.
   * Returns only the dirty buckets with their current values.
   *
   * IMPORTANT: Call this BEFORE flush() as flush() clears dirtyBuckets.
   *
   * @returns Array of bucket index/value pairs for broadcasting
   */
  getBucketUpdatesForBroadcast(): Array<{ index: number; value: number }> {
    return Array.from(this.dirtyBuckets).map((index) => ({
      index,
      value: this.utilizationState.dataCounters[index],
    }))
  }
}

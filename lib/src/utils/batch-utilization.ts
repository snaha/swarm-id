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
 * share the same slot space via the underlying stamper.
 *
 * Per-chunk encryption keys are derived deterministically from the account's
 * `swarmEncryptionKey` plus the chunk index and a small nonce. The nonce is
 * bumped only when an upload would land in the same bucket as a lower-index
 * chunk in the same save, so the on-chain placement of utilisation chunks is
 * tidy and dedup stays stable across re-saves.
 */

import {
  Stamper,
  BatchId,
  type Bee,
  EthAddress,
  PrivateKey,
  type EnvelopeWithBatchId,
} from "@ethersphere/bee-js"
import {
  makeEncryptedContentAddressedChunk,
  type ContentAddressedChunk,
} from "../chunk"
import { Binary, type Chunk as CafeChunk } from "cafe-utility"
import type { UtilizationStoreDB } from "../storage/utilization-store"
import { uploadData, type UploadTarget } from "../proxy/upload"
import { tryCreateTag } from "./tag"
import { lockSocAddress } from "./lock-soc"
import { deriveSecret } from "./key-derivation"
import { uint8ArrayToHex } from "./hex"

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown by `UtilizationAwareStamper.stamp()` when the partition lease was
 * invalidated (peer took over the partition) between binding and stamping.
 * Callers should surface this as "your partition was reclaimed" — the
 * upload cannot complete and any in-flight chunks would silently overwrite
 * the peer's data if stamped anyway.
 */
export class PartitionLeaseLostError extends Error {
  constructor(message = "Partition lease was reclaimed by another device.") {
    super(message)
    this.name = "PartitionLeaseLostError"
  }
}

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

/**
 * Reserved slots at the bottom of every bucket — one per partition, at
 * index = partition. They hold the partition's lock SOC / utilisation
 * (counter) chunk, are mutably overwritten, and do not count toward
 * utilisation. Data slots begin above them at `DATA_COUNTER_START`.
 */
export const UTILIZATION_SLOTS_PER_BUCKET = PARTITION_COUNT

/** First data slot index; reserved slots `[0, PARTITION_COUNT)` precede it. */
export const DATA_COUNTER_START = PARTITION_COUNT

/**
 * Partition-lease lifetime. A device holds its partition for this long
 * before the lease must be refreshed; if it crashes without refreshing,
 * peers can reclaim the partition via Case D.
 */
export const LEASE_TTL_MS = 30 * 1000 // 30 seconds

/**
 * How often the holder re-writes its partition lock SOC to bump
 * `leasedUntil`. One third of the TTL gives three "safety net" refresh
 * attempts before a peer would consider the lease expired.
 */
export const LEASE_REFRESH_MS = 10 * 1000 // 10 seconds

/**
 * How long a holder may go without an upload before it voluntarily yields
 * its partition (writes the release sentinel + publishes its final counter)
 * so a waiting device can take the slot without waiting out the full TTL.
 * The yielded device re-acquires transparently on its next upload. Enables
 * turn-taking among 3+ devices sharing `PARTITION_COUNT` slots.
 */
export const IDLE_YIELD_MS = 30 * 1000 // 30 seconds

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
// Per-chunk Encryption Key Derivation
// ============================================================================

/** Domain-separation tag for utilisation-chunk key derivation. */
const UTIL_CHUNK_KEY_DOMAIN = "swarm-id-util-chunk-v1"

/** Length of the SHA-256 HMAC output in bytes (also the chunk key length). */
const KEY_LENGTH = 32

/** Bytes to encode `chunkIndex` and `nonce` (each big-endian uint32). */
const UINT32_BYTES = 4

/**
 * Resolved per-chunk-index encryption material.
 *
 * `nonce` is the smallest non-negative integer that placed the chunk in a
 * bucket distinct from every chunk with a lower `chunkIndex` during the
 * current save. `key` is the HMAC-derived 32-byte key used to produce the
 * encrypted-CAC address (and therefore the chunk's bucket).
 */
export interface UtilizationChunkKey {
  key: Uint8Array
  nonce: number
}

/**
 * Derive the per-chunk encryption key used for utilisation chunks.
 *
 * `chunkKey = HMAC-SHA256(swarmEncryptionKey, "swarm-id-util-chunk-v1" || batchId || chunkIndex || nonce)`
 *
 * Same inputs → same key, so dedup at the upload path stays stable across
 * re-saves whenever neither the plaintext nor the chosen nonce changes.
 */
export async function deriveUtilizationChunkKey(
  swarmEncryptionKey: Uint8Array,
  batchId: BatchId,
  chunkIndex: number,
  nonce: number,
): Promise<Uint8Array> {
  if (swarmEncryptionKey.length !== KEY_LENGTH) {
    throw new Error(
      `Invalid swarmEncryptionKey length: ${swarmEncryptionKey.length} (expected ${KEY_LENGTH})`,
    )
  }

  const domain = new TextEncoder().encode(UTIL_CHUNK_KEY_DOMAIN)
  const batchIdBytes = batchId.toUint8Array()
  const indexBytes = new Uint8Array(UINT32_BYTES)
  new DataView(indexBytes.buffer).setUint32(0, chunkIndex, false)
  const nonceBytes = new Uint8Array(UINT32_BYTES)
  new DataView(nonceBytes.buffer).setUint32(0, nonce, false)
  const message = Binary.concatBytes(
    domain,
    batchIdBytes,
    indexBytes,
    nonceBytes,
  )

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    swarmEncryptionKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, message)
  return new Uint8Array(signature)
}

/**
 * Resolve the encryption key for a single utilisation chunk so it lands in a
 * bucket distinct from every other chunk in the same save, against a set of
 * already-claimed buckets. Mutates `claimedBuckets` to add the chosen one.
 *
 * Stability rule (matters for upload dedup): callers process chunks in
 * ascending `chunkIndex` order, and the first chunk to claim a bucket keeps
 * it. Each chunk starts its search from its `priorNonce`, so unchanged
 * plaintexts whose previously-chosen nonce still produces a distinct bucket
 * reuse the same key (and therefore the same CAC address) across saves —
 * dedup at `saveUtilizationState` then skips the upload.
 */
async function chooseUtilizationChunkKey(args: {
  swarmEncryptionKey: Uint8Array
  batchId: BatchId
  chunkIndex: number
  plaintext: Uint8Array
  priorNonce: number
  claimedBuckets: Set<number>
}): Promise<{
  key: Uint8Array
  nonce: number
  bucket: number
  address: Uint8Array
}> {
  const { swarmEncryptionKey, batchId, chunkIndex, plaintext, claimedBuckets } =
    args
  let nonce = args.priorNonce
  while (true) {
    const key = await deriveUtilizationChunkKey(
      swarmEncryptionKey,
      batchId,
      chunkIndex,
      nonce,
    )
    const encrypted = makeEncryptedContentAddressedChunk(plaintext, key)
    const address = encrypted.address.toUint8Array()
    const bucket = toBucket(address)
    if (!claimedBuckets.has(bucket)) {
      claimedBuckets.add(bucket)
      return { key, nonce, bucket, address }
    }
    nonce++
  }
}

/**
 * Collect the set of buckets currently claimed by clean utilisation chunks
 * (those whose `contentHash` already reflects the upload). Dirty chunks
 * must steer clear of these buckets when picking a key.
 */
function claimedBucketsForCleanChunks(
  state: BatchUtilizationState,
): Set<number> {
  const claimed = new Set<number>()
  for (const meta of state.chunks) {
    if (!meta.dirty && meta.contentHash) {
      claimed.add(toBucket(Binary.hexToUint8Array(meta.contentHash)))
    }
  }
  return claimed
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
 * @param data - Chunk data to upload (4KB)
 * @param encryptionKey - Encryption key (32 bytes)
 * @returns CAC reference
 */
export async function uploadUtilizationChunk(
  bee: Bee,
  stamper: Stamper,
  data: Uint8Array,
  encryptionKey: Uint8Array,
): Promise<Uint8Array> {
  // Validate inputs
  if (data.length < 1 || data.length > 4096) {
    throw new Error(`Invalid data length: ${data.length} (expected 1-4096)`)
  }
  if (encryptionKey.length !== KEY_LENGTH) {
    throw new Error(
      `Invalid encryption key length: ${encryptionKey.length} (expected ${KEY_LENGTH})`,
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

// ============================================================================
// Stamper Integration
// ============================================================================

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
          nonce: cached.nonce ?? 0,
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
        nonce: cached.nonce ?? 0,
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
  const isUtilStamper = stamper instanceof UtilizationAwareStamper

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

    if (isUtilStamper) {
      stamper.markReservedUtilizationChunk(resolved.address)
    }

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
      if (isUtilStamper) stamper.clearReservedUtilizationChunks()
      // Keep it marked as dirty for retry
      throw error
    }
  }

  if (isUtilStamper) stamper.clearReservedUtilizationChunks()

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

  /**
   * Partition this device holds within the shared postage batch. `undefined`
   * means the legacy single-device path: slot picking is delegated to the
   * inner bee-js stamper without any per-call coercion, which is the
   * behaviour for every account created before the partition-lease shipped.
   */
  private partition: number | undefined = undefined

  /**
   * Number of partitions the slot space is divided into. `1` is the
   * legacy/no-partitioning value and goes hand-in-hand with `partition`
   * being `undefined`.
   */
  private partitionCountValue: number = 1

  /**
   * Per-account lock-SOC addresses (one per partition). When `stamp()` sees
   * a chunk whose address matches one of these, it routes the write to the
   * lock SOC's reserved slot (= the partition index) within the same bucket,
   * bypassing the partition data-slot formula and the local counter bump.
   * Overstamping the same SOC at the same slot does not consume new slot
   * budget, so the heartbeat cadence is sustainable.
   *
   * Populated by `bindLockSocs()` once per stamper lifetime (deterministic
   * from accountId + partitionCount + owner). Independent of `partition`
   * binding so lock-SOC writes work both before and after `bindPartition`.
   */
  private lockSocs:
    | ReadonlyArray<{ partition: number; address: Uint8Array }>
    | undefined = undefined

  /**
   * Hex addresses of the utilisation (counter) chunks for the in-flight save,
   * mapped to the reserved SLOT each must overstamp. `stamp()` routes these to
   * that slot instead of a data slot. The slot is recorded at marking time
   * (not read from `this.partition` at stamp time) because the teardown
   * release publishes through an UNBOUND stamper — `partition` is already
   * undefined there, and falling back to slot 0 would overstamp the OTHER
   * partition's reserved chunks. Unlike the lock SOC, a counter chunk's
   * address changes whenever the counter changes, so writers register the
   * current set via `markReservedUtilizationChunk` and clear it with
   * `clearReservedUtilizationChunks`.
   */
  private reservedUtilizationChunks: Map<string, number> | undefined = undefined

  /**
   * The per-partition intent SOC for an in-flight intent round (Phase 2 —
   * `partition-intent.ts`), mapped to the reserved SLOT it must overstamp (the
   * contended partition index). Routed like the lock SOC / utilisation chunks:
   * `stamp()` places it in the partition's reserved slot, so it NEVER lands in
   * a data lane (`>= DATA_COUNTER_START`) and cannot overstamp user data.
   * Single-entry and self-clearing (set immediately before the upload, cleared
   * in a `finally`), so it stays isolated from the `reservedUtilizationChunks`
   * save lifecycle and never grows. See `reserveIntentSocSlot`.
   */
  private intentSoc: { addressHex: string; slot: number } | undefined =
    undefined

  /**
   * Promise-chain mutex serializing {@link withIntentSocSlot} critical sections.
   * The intent / occupancy / state-pointer SOC writes all share the single
   * {@link intentSoc} reservation, but their callers run concurrently (the
   * off-lock refresh-tick presence/occupancy beacon vs. an under-lock upload's
   * state-pointer publish). Without this, the two reserve→stamp windows overlap:
   * the second `reserveIntentSocSlot` clobbers the first's address, so the
   * first `stamp()` no longer matches `intentSoc` and falls through to a DATA
   * slot — consuming data budget and bumping the counter under the very publish
   * that is diffing it. The mutex makes each writer wait for the previous to
   * clear its reservation.
   */
  private intentSocLock: Promise<void> = Promise.resolve()

  /**
   * Circuit breaker for in-flight uploads. Flipped to `true` when the proxy
   * detects displacement on a refresh tick (or upload-start lease check);
   * subsequent partition-bound `stamp()` calls throw `PartitionLeaseLostError`
   * to abort the upload cleanly instead of silently corrupting the peer's
   * slot space.
   */
  private leaseStale: boolean = false

  /**
   * Per-partition buckets of the latest published partition-state chunks.
   * Utilisation saves must not place chunks in these buckets (same reserved
   * slot → overstamp → the published resume point is evicted from the
   * reserve). Mirrors `BatchMetadata.stateChunkBuckets`; restored on create.
   */
  private protectedStateBuckets = new Map<number, ReadonlySet<number>>()

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

  /** Current partition (undefined in single-device legacy mode). */
  get currentPartition(): number | undefined {
    return this.partition
  }

  /** Total partition count (1 in legacy mode). */
  get partitionCount(): number {
    return this.partitionCountValue
  }

  /**
   * Per-bucket local stamping counter, exposed so the lease orchestrator
   * can publish it to the partition-state feed on release. Returns
   * undefined in legacy mode.
   */
  getLocalCounter(): Uint32Array | undefined {
    return this.partition !== undefined
      ? this.utilizationState.dataCounters
      : undefined
  }

  /**
   * Buckets that contain a per-partition lock SOC. External callers that
   * persist utilisation chunks (e.g. `saveUtilizationState` from the sync
   * path) should treat these as already claimed so utilisation-chunk key
   * search avoids dropping a chunk on the lock SOC's bucket.
   */
  getLockSocBuckets(): ReadonlySet<number> {
    const set = new Set<number>()
    for (const soc of this.lockSocs ?? []) {
      set.add(toBucket(soc.address))
    }
    return set
  }

  /**
   * All buckets a utilisation save must avoid: the lock-SOC buckets plus the
   * buckets of the latest published partition-state chunks for the partition
   * this stamper writes reserved slots in (`partition ?? 0`). A utilisation
   * chunk landing in a published state chunk's bucket would overstamp the
   * same reserved slot and evict the published chunk from the reserve —
   * destroying the resume point a later takeover depends on.
   */
  getProtectedBuckets(): ReadonlySet<number> {
    const set = new Set<number>(this.getLockSocBuckets())
    const stateBuckets = this.protectedStateBuckets.get(this.partition ?? 0)
    for (const bucket of stateBuckets ?? []) {
      set.add(bucket)
    }
    return set
  }

  /**
   * Buckets occupied by this stamper's current CLEAN utilisation chunks.
   * The partition-state publish avoids them so a randomly-keyed state chunk
   * does not evict a live utilisation chunk from the reserve.
   */
  getCleanChunkBuckets(): ReadonlySet<number> {
    return claimedBucketsForCleanChunks(this.utilizationState)
  }

  /**
   * Record the buckets occupied by the latest published partition-state
   * chunks for `partition` (in memory + persisted in the batch metadata, so
   * a reload keeps avoiding them). Called after every successful publish
   * (`PartitionLease.release`) and after every successful state read
   * (`claimPartition`) — the set is replaced wholesale; only the latest
   * publish needs protection, superseded chunks are dead.
   */
  async setProtectedStateBuckets(
    partition: number,
    buckets: number[],
  ): Promise<void> {
    this.protectedStateBuckets.set(partition, new Set(buckets))
    const batchId = this.batchId.toHex()
    const existing = await this.cache.getMetadata(batchId)
    await this.cache.putMetadata({
      batchId,
      lastSync: existing?.lastSync ?? Date.now(),
      chunkCount: existing?.chunkCount ?? 0,
      syncedReferences: existing?.syncedReferences,
      stateChunkBuckets: {
        ...(existing?.stateChunkBuckets ?? {}),
        [partition]: buckets,
      },
    })
  }

  /**
   * Bind this stamper to a leased partition. Called once by the lease
   * orchestrator after `acquire()` succeeds. `localCounter` is the
   * starting per-bucket count for THIS device — fresh zeros for Case A,
   * the resumed high-water from the state feed for Cases B/D.
   */
  bindPartition(opts: {
    partition: number
    partitionCount: number
    localCounter: Uint32Array
  }): void {
    if (opts.localCounter.length !== NUM_BUCKETS) {
      throw new Error(
        `localCounter must have ${NUM_BUCKETS} entries, got ${opts.localCounter.length}`,
      )
    }
    this.partition = opts.partition
    this.partitionCountValue = opts.partitionCount
    // The seeded per-partition counter (`j`, resumed high-water for Cases
    // B/D) becomes the single counter of record for this held partition.
    this.utilizationState.dataCounters = opts.localCounter
    this.leaseStale = false
  }

  /**
   * Bind the per-partition lock-SOC addresses. Called once per stamper
   * lifetime (the addresses are deterministic from the account). Routes
   * lock-SOC overstamps to a fixed reserved slot per partition so the tight
   * heartbeat cadence doesn't consume new slot budget every refresh.
   *
   * Independent of `bindPartition` — can be called before the partition
   * lease is acquired (the first lock-SOC write inside `acquirePartitionLock`
   * needs this routing to already be in place).
   */
  bindLockSocs(
    socs: ReadonlyArray<{ partition: number; address: Uint8Array }>,
  ): void {
    this.lockSocs = socs
  }

  /**
   * Register a utilisation/state chunk address so the next `stamp()` of it
   * routes to a reserved slot instead of a data slot. `slot` defaults to the
   * currently bound partition — pass it explicitly when the stamper may be
   * unbound at stamp time (the teardown release publishes state chunks after
   * `unbindPartition()`, and a default of 0 would overstamp partition 0's
   * reserved chunks). Idempotent per address.
   */
  markReservedUtilizationChunk(address: Uint8Array, slot?: number): void {
    if (!this.reservedUtilizationChunks) {
      this.reservedUtilizationChunks = new Map()
    }
    this.reservedUtilizationChunks.set(
      uint8ArrayToHex(address),
      slot ?? this.partition ?? 0,
    )
  }

  /** Clear the registered utilisation-chunk addresses after a save. */
  clearReservedUtilizationChunks(): void {
    this.reservedUtilizationChunks = undefined
  }

  /**
   * Register the per-partition intent SOC so `stamp()` routes it to `slot`
   * (the contended partition's reserved index) instead of a data slot — never
   * consuming data budget or bumping the counter. `slot` is passed explicitly
   * because the intent round runs BEFORE `bindPartition`, so `this.partition`
   * is not yet set. Call immediately before the upload; pair with
   * `clearIntentSocSlot` in a `finally`.
   */
  reserveIntentSocSlot(address: Uint8Array, slot: number): void {
    this.intentSoc = { addressHex: uint8ArrayToHex(address), slot }
  }

  /** Clear the registered intent SOC after its upload. */
  clearIntentSocSlot(): void {
    this.intentSoc = undefined
  }

  /**
   * Reserve the intent-SOC slot for `address`, run `fn` (the upload), then
   * clear it — serialized against every other `withIntentSocSlot` call on this
   * stamper so concurrent intent/occupancy/state-pointer writes can't clobber
   * one another's reservation (see {@link intentSocLock}). Production callers
   * (`writeReservedPartitionSoc`, `writeStatePointer`) MUST use this instead of
   * the bare `reserveIntentSocSlot`/`clearIntentSocSlot` pair. `partition` is the
   * reserved slot index the SOC routes to (the contended partition's index).
   */
  async withIntentSocSlot<T>(
    address: Uint8Array,
    partition: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.intentSocLock
    let release!: () => void
    this.intentSocLock = new Promise<void>((resolve) => (release = resolve))
    await previous
    // `reserveIntentSocSlot` inside the try so `release()` still runs if it (or
    // `fn`) ever throws — otherwise `intentSocLock` would stay pending forever
    // and every later intent/occupancy/state-pointer write on this stamper would
    // deadlock on `await previous`.
    try {
      this.reserveIntentSocSlot(address, partition)
      return await fn()
    } finally {
      this.clearIntentSocSlot()
      release()
    }
  }

  /**
   * Inverse of `bindPartition` — clears partition slot state on demote.
   * Leaves `lockSocs` intact (still valid for the account; refresh/yield
   * writes may need them) and clears the lease-stale flag.
   */
  unbindPartition(): void {
    this.partition = undefined
    this.partitionCountValue = 1
    this.leaseStale = false
  }

  /**
   * Circuit-break: mark the bound lease as stale. The next partition-bound
   * `stamp()` call will throw `PartitionLeaseLostError` so an in-flight
   * upload aborts cleanly mid-stream when a peer takes our partition.
   */
  invalidateLease(): void {
    this.leaseStale = true
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
    owner: EthAddress,
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

    const instance = new UtilizationAwareStamper(
      stamper,
      batchId,
      depth,
      cache,
      encryptionKey,
      utilizationState,
    )

    // Restore the protected partition-state buckets so saves keep avoiding
    // the published resume point across reloads. Tolerates minimal caches
    // (tests stub only getAllChunks/putChunk).
    try {
      const meta = await cache.getMetadata?.(batchId.toHex())
      for (const [p, buckets] of Object.entries(
        meta?.stateChunkBuckets ?? {},
      )) {
        instance.protectedStateBuckets.set(Number(p), new Set(buckets))
      }
    } catch (error) {
      console.warn(
        `[UtilizationAwareStamper] Failed to restore protected state buckets:`,
        error,
      )
    }

    // Auto-bind lock SOCs for all partitions. The lock-SOC owner is the
    // BACKUP signer's address — same value `writePartitionLock` derives
    // internally — NOT the `owner` parameter callers pass (which is the
    // account / postage-signer address depending on call site). Deriving
    // here from `encryptionKey` (= swarmEncryptionKey at every call site)
    // makes the routing self-consistent regardless of caller. Harmless for
    // single-device legacy accounts (the lock SOCs are never written).
    void owner // currently unused; reserved for a future Swarm upload path.
    const swarmEncryptionKeyHex = uint8ArrayToHex(encryptionKey)
    const backupKeyHex = await deriveSecret(swarmEncryptionKeyHex, "backup-key")
    const backupSigner = new PrivateKey(backupKeyHex)
    const backupOwner = backupSigner.publicKey().address()
    instance.lockSocs = Array.from({ length: PARTITION_COUNT }, (_, p) => ({
      partition: p,
      address: lockSocAddress(p, backupOwner),
    }))

    return instance
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
    const chunkAddress = chunk.hash()

    // Lock-SOC short-circuit: when stamping our own per-partition lock SOC,
    // overstamp the fixed reserved slot (= partition index, 0 or 1) within
    // its bucket. Doesn't consume new slot budget, doesn't bump our local
    // counter — the SOC address is the same on every refresh, so the slot
    // it occupies stays the same too.
    const lockSoc = this.lockSocs?.find((soc) =>
      Binary.equals(soc.address, chunkAddress),
    )
    if (lockSoc) {
      const bucket = toBucket(chunkAddress)
      this.stamper.buckets[bucket] = lockSoc.partition
      return this.stamper.stamp(chunk)
    }

    // Utilisation-chunk short-circuit: a counter/state chunk overstamps its
    // bucket's reserved slot (recorded at marking time), just like the lock
    // SOC. Persisting the counter therefore never consumes a data slot or
    // bumps the counter. The addresses are content-derived (they change as the
    // counter changes), so writers register the current save's addresses via
    // `markReservedUtilizationChunk` before uploading them.
    const reservedSlot = this.reservedUtilizationChunks?.get(
      uint8ArrayToHex(chunkAddress),
    )
    if (reservedSlot !== undefined) {
      const bucket = toBucket(chunkAddress)
      this.stamper.buckets[bucket] = reservedSlot
      return this.stamper.stamp(chunk)
    }

    // Intent-SOC short-circuit: a partition-intent chunk (Phase 2) overstamps
    // the contended partition's reserved slot — like the lock SOC, below the
    // data lanes — so it can never collide with user data. Doesn't bump the
    // counter. Not gated by `leaseStale`: the intent round runs before binding,
    // while no lease is held.
    if (
      this.intentSoc !== undefined &&
      this.intentSoc.addressHex === uint8ArrayToHex(chunkAddress)
    ) {
      const bucket = toBucket(chunkAddress)
      this.stamper.buckets[bucket] = this.intentSoc.slot
      return this.stamper.stamp(chunk)
    }

    // Partition lease was reclaimed — abort cleanly before the stamp lands
    // in slot space the peer now controls. Only meaningful when a partition
    // is bound (single-device legacy mode has no lease to invalidate).
    if (this.partition !== undefined && this.leaseStale) {
      throw new PartitionLeaseLostError()
    }

    // Coerce the bee-js stamper to this device's next slot in its partition's
    // lane: slot = partitionCount + partition + partitionCount·j, where j is
    // the per-partition counter. Legacy single-device is partition 0, K=1
    // (data from slot 1, reserved slot 0). The bee-js `Stamper.buckets` is a
    // public mutable Uint32Array held by reference — overwriting before each
    // stamp is sufficient.
    {
      const bucket = (chunkAddress[0] << 8) | chunkAddress[1]
      this.stamper.buckets[bucket] = dataSlot(
        this.partition ?? 0,
        this.utilizationState.dataCounters[bucket],
        this.partitionCountValue,
      )
    }

    const envelope = this.stamper.stamp(chunk)

    // Extract bucket from envelope index
    // The index is 8 bytes: first 4 bytes = bucket (big-endian), last 4 bytes = slot
    const view = new DataView(
      envelope.index.buffer,
      envelope.index.byteOffset,
      envelope.index.byteLength,
    )
    const bucket = view.getUint32(0, false) // false = big-endian

    // Advance the per-partition counter so the next stamp into this bucket
    // lands on this partition's next slot.
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
    // the encrypted chunk for this plaintext + the per-chunk derived key. That
    // is what the upload-path dedup at saveUtilizationState compares against,
    // so storing anything else (or using a different key) would force a
    // redundant re-upload of every flushed chunk on the next sync.
    try {
      const claimedBuckets = claimedBucketsForCleanChunks(this.utilizationState)
      // Reserve each partition's lock-SOC bucket so utilisation-chunk key
      // search picks a different nonce. Otherwise a utilisation chunk could
      // land in the same bucket and try to claim slot 0/1 — the slot the
      // lock SOC overstamps every refresh.
      for (const soc of this.lockSocs ?? []) {
        claimedBuckets.add(toBucket(soc.address))
      }
      // Also reserve the latest published partition-state chunks' buckets —
      // they share this partition's reserved slot, and overstamping one
      // evicts the resume point a later takeover depends on.
      for (const bucket of this.protectedStateBuckets.get(
        this.partition ?? 0,
      ) ?? []) {
        claimedBuckets.add(bucket)
      }
      const sortedDirtyChunkIndexes = Array.from(dirtyChunkIndexes).sort(
        (a, b) => a - b,
      )
      for (const chunkIndex of sortedDirtyChunkIndexes) {
        const chunkData = extractChunk(
          this.utilizationState.dataCounters,
          chunkIndex,
          this.depth,
        )

        const resolved = await chooseUtilizationChunkKey({
          swarmEncryptionKey: this.encryptionKey,
          batchId: this.batchId,
          chunkIndex,
          plaintext: chunkData,
          priorNonce: this.utilizationState.chunks[chunkIndex].nonce,
          claimedBuckets,
        })
        const contentHash = Binary.uint8ArrayToHex(resolved.address)

        await this.cache.putChunk({
          batchId: this.batchId.toHex(),
          chunkIndex,
          data: chunkData,
          contentHash,
          nonce: resolved.nonce,
          lastAccess: Date.now(),
        })
        this.utilizationState.chunks[chunkIndex].contentHash = contentHash
        this.utilizationState.chunks[chunkIndex].nonce = resolved.nonce
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
   * Build the partition-local counter from the stamper's current
   * `dataCounters` — i.e. resume exactly where this device left off. The
   * lease orchestrator passes the result into `bindPartition` as the seed
   * counter for a held partition.
   */
  buildLeaseLocalCounter(): Uint32Array {
    return this.utilizationState.dataCounters.slice()
  }

  /**
   * Read the cached "synced reference" for `partition` — the partition-state
   * feed reference this device's local counter was last in sync with. Used by
   * the acquire path to skip re-downloading unchanged counter chunks.
   */
  async getSyncedReference(partition: number): Promise<string | undefined> {
    const meta = await this.cache.getMetadata(this.batchId.toHex())
    return meta?.syncedReferences?.[partition]
  }

  /**
   * Record the partition-state feed reference this device's local counter is
   * now in sync with (after a download or a publish). Merges into the existing
   * batch metadata so other fields / partitions are preserved.
   */
  async setSyncedReference(
    partition: number,
    referenceHex: string,
  ): Promise<void> {
    const batchId = this.batchId.toHex()
    const existing = await this.cache.getMetadata(batchId)
    await this.cache.putMetadata({
      batchId,
      lastSync: existing?.lastSync ?? Date.now(),
      chunkCount: existing?.chunkCount ?? 0,
      syncedReferences: {
        ...(existing?.syncedReferences ?? {}),
        [partition]: referenceHex,
      },
      stateChunkBuckets: existing?.stateChunkBuckets,
    })
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

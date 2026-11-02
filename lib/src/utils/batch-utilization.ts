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
 *
 * Per-chunk encryption keys are derived deterministically from the account's
 * `swarmEncryptionKey` plus the chunk index and a small nonce. The nonce is
 * bumped only when an upload would land in the same bucket as a lower-index
 * chunk in the same save, so the on-chain placement of utilisation chunks is
 * tidy and dedup stays stable across re-saves.
 */

import { type Stamper, BatchId, type Bee } from "@ethersphere/bee-js"
import {
  makeEncryptedContentAddressedChunk,
  type ContentAddressedChunk,
} from "../chunk"
import { Binary } from "cafe-utility"
import type { UtilizationStoreDB } from "../storage/utilization-store"
import { uploadChunk, type UploadTarget } from "../proxy/upload"
import { tryCreateTag } from "./tag"

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

// Partition-lease lifetime — single source in `sync/timing-constants` (shared
// with `partition-intent`'s epoch, which tracks it). Re-exported here so the
// many `import { LEASE_TTL_MS } from "../utils/batch-utilization"` callers are
// unchanged.
export { LEASE_TTL_MS } from "../sync/timing-constants"

/**
 * How often the holder re-writes its partition lock SOC to bump
 * `leasedUntil`. One third of the TTL gives three "safety net" refresh
 * attempts before a peer would consider the lease expired.
 */
export const LEASE_REFRESH_MS = 10 * 1000 // 10 seconds

/**
 * Local-clock margin for treating a lease as "could have lapsed". A holder must
 * stop writing (and re-validating before ack) once `now >= leasedUntil - margin`
 * so it ceases before a peer — reading the same `leasedUntil` from the lock SOC
 * — could validly take over. Bounds the write/ack exposure to NTP-level skew,
 * the same assumption the lock protocol already makes. Consumed by the stamper's
 * local-lapse fence and the coordinator's reverse-clobber guard.
 */
export const LEASE_SKEW_MARGIN_MS = 2000

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
export async function chooseUtilizationChunkKey(args: {
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
export function claimedBucketsForCleanChunks(
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

  // Upload the exact encrypted bytes the reference was computed from —
  // re-encrypting would randomize the padding of sub-4096 plaintexts and
  // change the address (deferred: false for fast return)
  await uploadChunk(target, encryptedChunk.data, {
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

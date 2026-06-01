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
  Topic,
  Identifier,
  type Bee,
  EthAddress,
  PrivateKey,
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
import type { EpochUpdateHints } from "../proxy/feeds/epochs/types"
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
 * Per-bucket slot headroom carried by `DATA_COUNTER_START`. Sized so that
 * the rare case of two utilisation chunks landing in the same bucket cannot
 * push a stamp past the headroom; with ~32 chunks into 65,536 buckets even a
 * 3-way collision is below 10⁻⁷ per save, so 2 is comfortably enough.
 * Choosing an even value keeps remainders even under a future K=2
 * multi-device partitioning so per-bucket slot allocation splits cleanly.
 */
export const UTILIZATION_SLOTS_PER_BUCKET = 2

/** Starting slot index for data chunks */
export const DATA_COUNTER_START = 2

/**
 * Number of partitions the per-bucket slot space is divided into for
 * multi-device sharing of a single postage batch. With K=2, device 0
 * uses slots `{DATA_COUNTER_START + 0, DATA_COUNTER_START + 2, …}` and
 * device 1 uses `{DATA_COUNTER_START + 1, DATA_COUNTER_START + 3, …}`.
 */
export const PARTITION_COUNT = 2

/**
 * Partition-lease lifetime. A device holds its partition for this long
 * before the lease must be refreshed; if it crashes without refreshing,
 * peers can reclaim the partition via Case D.
 */
export const LEASE_TTL_MS = 30 * 1000 // 30 seconds

/**
 * How often the holder bumps `leasedUntil` on its own claim feed. One
 * third of the TTL gives three "safety net" refresh attempts before a
 * peer would consider the lease expired.
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

/**
 * Counter-skew divisor for `RESUME_COUNTER_SKEW = ceil(slotsPerBucket /
 * PARTITION_COUNT / RESUME_COUNTER_SKEW_DIVISOR)`. Applied when seeding
 * `localCounter` from a peer's partition-state snapshot — skips a small
 * slot range that the previous holder may have used between its last
 * published snapshot and a crash. Cheap defence; loses a sliver of
 * capacity per handover/recovery.
 */
export const RESUME_COUNTER_SKEW_DIVISOR = 4

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
 * Counter-skew applied when seeding `localCounter` from a cached state on
 * reconnect. Skips a small slot range that the previous session may have
 * used after its last flush but before a crash, eliminating residual
 * collision risk.
 */
export function computeResumeCounterSkew(batchDepth: number): number {
  const slotsPerBucket = Math.pow(2, batchDepth - BUCKET_DEPTH)
  return Math.ceil(
    slotsPerBucket / PARTITION_COUNT / RESUME_COUNTER_SKEW_DIVISOR,
  )
}

/**
 * IndexedDB chunk index for the per-partition lease metadata chunk.
 * Lease metadata is stored at indices `N + p` where N = numUtilizationChunks.
 */
export function leaseChunkIndex(batchDepth: number, partition: number): number {
  const { numUtilizationChunks } = getChunkLayout(batchDepth)
  return numUtilizationChunks + partition
}

/**
 * Cached lease input for the 0-reads fast-path in `PartitionLease.acquire()`.
 *
 * A returning device that still holds a valid lease can bypass `readPartitionState`
 * and `readDeviceClaim(self)` by passing this struct — the stamper's local
 * IndexedDB data is sufficient to reconstruct the partition state.
 */
export interface CachedLeaseInput {
  partition: number
  /** Last known generation; next claim uses `generation + 1`. */
  generation: number
  /**
   * Per-bucket local counter to pass to `bindPartition`. The skew has
   * already been applied (`dataCounters + RESUME_COUNTER_SKEW`).
   */
  localCounter: Uint32Array
  /** Epoch hints for `writeDeviceClaim`, skips epoch-tree traversal. */
  claimHints: EpochUpdateHints
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
 * Choose per-chunk encryption keys so each utilisation chunk lands in a
 * bucket distinct from every other chunk in the same save.
 *
 * Stability rule (matters for upload dedup): chunks are processed in
 * ascending `chunkIndex` order, and the first chunk to claim a bucket
 * keeps it. Each chunk starts its search from `priorNonces[i] ?? 0`, so
 * unchanged plaintexts whose previously-chosen nonce still produces a
 * distinct bucket reuse the same key (and therefore the same CAC address)
 * across saves — dedup at `saveUtilizationState` then skips the upload.
 *
 * In practice almost every save finds zero collisions: with 32 chunks over
 * 65,536 buckets the expected number of bumps per save is ≈ 0.008.
 */
export async function resolveUtilizationChunkKeys(
  plaintexts: Uint8Array[],
  options: {
    swarmEncryptionKey: Uint8Array
    batchId: BatchId
    priorNonces?: Record<number, number>
  },
): Promise<{
  keys: UtilizationChunkKey[]
  buckets: number[]
}> {
  const { swarmEncryptionKey, batchId, priorNonces } = options
  const keys: UtilizationChunkKey[] = new Array(plaintexts.length)
  const buckets: number[] = new Array(plaintexts.length)
  const claimedBuckets = new Set<number>()

  for (let i = 0; i < plaintexts.length; i++) {
    const resolved = await chooseUtilizationChunkKey({
      swarmEncryptionKey,
      batchId,
      chunkIndex: i,
      plaintext: plaintexts[i],
      priorNonce: priorNonces?.[i] ?? 0,
      claimedBuckets,
    })
    keys[i] = { key: resolved.key, nonce: resolved.nonce }
    buckets[i] = resolved.bucket
  }

  return { keys, buckets }
}

/**
 * Resolve the encryption key for a single chunk index against a set of
 * already-claimed buckets. Mutates `claimedBuckets` to add the chosen one.
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
  const dataCounters = new Uint32Array(NUM_BUCKETS)

  // Initialize data counters to start at slot DATA_COUNTER_START.
  // The first `DATA_COUNTER_START` slots of every bucket act as headroom
  // for utilisation chunks that incidentally land there.
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
      nonce: 0,
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
          nonce: cached.nonce ?? 0,
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
        nonce: cached.nonce ?? 0,
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
      nonce: 0,
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

    try {
      // Upload to Swarm as encrypted CAC with the per-chunk derived key
      const cacReference = await uploadUtilizationChunk(
        bee,
        stamper,
        chunkIndex,
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
// Lease Metadata Serialization
// ============================================================================

interface ClaimHintsJson {
  lastEpoch?: { start: string; level: number }
  lastTimestamp?: string
}

interface LeaseMetadataPayload {
  generation: number
  claimHints: ClaimHintsJson
}

function serializeClaimHints(hints: EpochUpdateHints): ClaimHintsJson {
  return {
    lastEpoch: hints.lastEpoch
      ? {
          start: hints.lastEpoch.start.toString(),
          level: hints.lastEpoch.level,
        }
      : undefined,
    lastTimestamp: hints.lastTimestamp?.toString(),
  }
}

function deserializeClaimHints(json: ClaimHintsJson): EpochUpdateHints {
  return {
    lastEpoch: json.lastEpoch
      ? { start: BigInt(json.lastEpoch.start), level: json.lastEpoch.level }
      : undefined,
    lastTimestamp:
      json.lastTimestamp !== undefined ? BigInt(json.lastTimestamp) : undefined,
  }
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
   * Per-bucket "how many chunks have I stamped here" — the `j` in the
   * doc's slot formula `slot = DATA_COUNTER_START + p + K·j`. Each
   * `stamp()` reads this to compute the next slot for its partition,
   * then increments it. Separate from `dataCounters` (which is the
   * batch-wide total, including peers' contributions seeded from the
   * partition-state feed).
   */
  private partitionLocalCounter: Uint32Array | undefined = undefined

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
   * Circuit breaker for in-flight uploads. Flipped to `true` when the proxy
   * detects displacement on a refresh tick (or upload-start lease check);
   * subsequent partition-bound `stamp()` calls throw `PartitionLeaseLostError`
   * to abort the upload cleanly instead of silently corrupting the peer's
   * slot space.
   */
  private leaseStale: boolean = false

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
    return this.partitionLocalCounter
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
   * Bind this stamper to a leased partition. Called once by the lease
   * orchestrator after `acquire()` succeeds. `localCounter` is the
   * starting per-bucket count for THIS device — fresh zeros for Case A,
   * seeded-from-state-feed-with-skew for Cases B/D.
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
    this.partitionLocalCounter = opts.localCounter
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
   * Inverse of `bindPartition` — clears partition slot state on demote.
   * Leaves `lockSocs` intact (still valid for the account; refresh/yield
   * writes may need them) and clears the lease-stale flag.
   */
  unbindPartition(): void {
    this.partition = undefined
    this.partitionCountValue = 1
    this.partitionLocalCounter = undefined
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

    // Partition lease was reclaimed — abort cleanly before the stamp lands
    // in slot space the peer now controls. Only meaningful when a partition
    // is bound (single-device legacy mode has no lease to invalidate).
    if (this.partition !== undefined && this.leaseStale) {
      throw new PartitionLeaseLostError()
    }

    // When holding a partition lease, coerce the bee-js stamper to use this
    // device's next partition slot instead of the next "any" slot. The bee-js
    // `Stamper.buckets` is a public mutable Uint32Array (bee-js/src/stamper/stamper.ts:8,20,46),
    // held by reference — overwriting before each stamp is sufficient.
    if (
      this.partition !== undefined &&
      this.partitionLocalCounter !== undefined
    ) {
      const bucket = (chunkAddress[0] << 8) | chunkAddress[1]
      const slot =
        DATA_COUNTER_START +
        this.partition +
        this.partitionCountValue * this.partitionLocalCounter[bucket]
      this.stamper.buckets[bucket] = slot
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

    // Update partition-local counter so the next stamp into this bucket lands
    // on the partition's next slot. (Legacy single-device path leaves this
    // counter alone — slot picking falls through to the bee-js stamper.)
    if (this.partitionLocalCounter !== undefined) {
      this.partitionLocalCounter[bucket]++
    }

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
   * `dataCounters` + `RESUME_COUNTER_SKEW`.
   *
   * Same derivation `readCachedLease` does internally, exposed standalone
   * for callers that already have lease state from somewhere else (e.g.
   * `LeaseState` in localStorage) and just need the seed counter to pass
   * into `bindPartition`.
   */
  buildLeaseLocalCounter(): Uint32Array {
    const skew = computeResumeCounterSkew(this.depth)
    const localCounter = new Uint32Array(NUM_BUCKETS)
    for (let i = 0; i < NUM_BUCKETS; i++) {
      localCounter[i] = this.utilizationState.dataCounters[i] + skew
    }
    return localCounter
  }

  /**
   * Persist lease metadata (generation + claimHints) for partition `p` in
   * the local IndexedDB cache at chunk index `N + p`.
   * Called after a successful cold acquire so subsequent reloads can skip
   * `readPartitionState` and `readDeviceClaim(self)` entirely.
   */
  async setLeaseMetadata(
    partition: number,
    generation: number,
    claimHints: EpochUpdateHints,
  ): Promise<void> {
    const payload: LeaseMetadataPayload = {
      generation,
      claimHints: serializeClaimHints(claimHints),
    }
    const data = new TextEncoder().encode(JSON.stringify(payload))
    await this.cache.putChunk({
      batchId: this.batchId.toHex(),
      chunkIndex: leaseChunkIndex(this.depth, partition),
      data,
      contentHash: "",
      lastAccess: Date.now(),
    })
  }

  /**
   * Update lease metadata for the currently held partition (after refresh).
   * No-op when no partition is bound.
   */
  async updateLeaseMetadata(
    generation: number,
    claimHints: EpochUpdateHints,
  ): Promise<void> {
    if (this.partition === undefined) return
    await this.setLeaseMetadata(this.partition, generation, claimHints)
  }

  /**
   * Read cached lease metadata for partition `p` and derive the local
   * counter from the current `dataCounters` + `RESUME_COUNTER_SKEW`.
   * Returns `undefined` when no metadata chunk is present in the cache.
   */
  async readCachedLease(
    partition: number,
  ): Promise<CachedLeaseInput | undefined> {
    const cached = await this.cache.getChunk(
      this.batchId.toHex(),
      leaseChunkIndex(this.depth, partition),
    )
    if (!cached) return undefined

    const payload: LeaseMetadataPayload = JSON.parse(
      new TextDecoder().decode(cached.data),
    )
    const claimHints = deserializeClaimHints(payload.claimHints)
    const skew = computeResumeCounterSkew(this.depth)
    const localCounter = new Uint32Array(NUM_BUCKETS)
    for (let i = 0; i < NUM_BUCKETS; i++) {
      localCounter[i] = this.utilizationState.dataCounters[i] + skew
    }
    return {
      partition,
      generation: payload.generation,
      localCounter,
      claimHints,
    }
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

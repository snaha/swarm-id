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

import { Stamper, BatchId, type Chunk } from '@ethersphere/bee-js'
import { makeContentAddressedChunk } from '@ethersphere/bee-js'

// ============================================================================
// Constants
// ============================================================================

/** Number of buckets in a postage batch (2^16) */
export const NUM_BUCKETS = 65536

/** Bucket depth parameter (determines bucket count) */
export const BUCKET_DEPTH = 16

/** Number of slots reserved per bucket for utilization chunks (0-255) */
export const UTILIZATION_SLOTS_PER_BUCKET = 256

/** Starting slot index for data chunks */
export const DATA_COUNTER_START = 256

/** Size of each chunk in bytes */
export const CHUNK_SIZE = 4096

/** Batch depth for N=256 slots per bucket with 65536 buckets */
export const DEFAULT_BATCH_DEPTH = 24

// ============================================================================
// Types
// ============================================================================

/**
 * Utilization state for a postage batch
 */
export interface BatchUtilizationState {
	/** Batch ID this state belongs to */
	batchId: BatchId

	/** Data counters stored on Swarm (256+ per bucket) */
	dataCounters: Uint32Array // [65536]

	/** Addresses of the chunks storing the serialized dataCounters */
	utilizationChunkAddresses: string[]

	/** Last update timestamp */
	lastUpdate: number
}

/**
 * Chunk with bucket assignment
 */
export interface ChunkWithBucket {
	chunk: Chunk
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
		throw new Error('Chunk address must be at least 2 bytes')
	}

	// First 2 bytes as big-endian uint16
	return (chunkAddress[0] << 8) | chunkAddress[1]
}

/**
 * Calculate bucket assignments for multiple chunks
 */
export function assignChunksToBuckets(chunks: Chunk[]): ChunkWithBucket[] {
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
		throw new Error('Byte array length must be a multiple of 4')
	}

	const arr = new Uint32Array(bytes.length / 4)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	for (let i = 0; i < arr.length; i++) {
		arr[i] = view.getUint32(i * 4, true) // true = little-endian
	}

	return arr
}

/**
 * Split data into 4KB chunks
 */
export function splitIntoChunks(data: Uint8Array): Chunk[] {
	const chunks: Chunk[] = []

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
export function reconstructFromChunks(chunks: Chunk[], originalLength: number): Uint8Array {
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
 */
export function initializeBatchUtilization(batchId: BatchId): BatchUtilizationState {
	const dataCounters = new Uint32Array(NUM_BUCKETS)

	// Initialize data counters to start at slot 256
	dataCounters.fill(DATA_COUNTER_START)

	return {
		batchId,
		dataCounters,
		utilizationChunkAddresses: [],
		lastUpdate: Date.now(),
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
	dataChunks: Chunk[],
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

	// Step 3: Serialize updated data counters
	const serialized = serializeUint32Array(newDataCounters)
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
export function prepareBucketState(chunksWithBuckets: ChunkWithBucket[]): Uint32Array {
	const bucketState = new Uint32Array(NUM_BUCKETS)

	// Set each bucket height to the slot we want to write to
	for (const { bucket, slot } of chunksWithBuckets) {
		// Use the highest slot we need for this bucket
		bucketState[bucket] = Math.max(bucketState[bucket], slot)
	}

	return bucketState
}

// ============================================================================
// Storage Operations
// ============================================================================

const STORAGE_KEY_PREFIX = 'batch-utilization-'

/**
 * Save utilization state to localStorage
 */
export function saveUtilizationState(state: BatchUtilizationState): void {
	const key = `${STORAGE_KEY_PREFIX}${state.batchId.toHex()}`

	const serialized = {
		batchId: state.batchId.toHex(),
		dataCounters: Array.from(state.dataCounters),
		utilizationChunkAddresses: state.utilizationChunkAddresses,
		lastUpdate: state.lastUpdate,
	}

	localStorage.setItem(key, JSON.stringify(serialized))
}

/**
 * Load utilization state from localStorage
 */
export function loadUtilizationState(batchId: BatchId): BatchUtilizationState | undefined {
	const key = `${STORAGE_KEY_PREFIX}${batchId.toHex()}`
	const stored = localStorage.getItem(key)

	if (!stored) {
		return undefined
	}

	try {
		const parsed = JSON.parse(stored)

		return {
			batchId: new BatchId(parsed.batchId),
			dataCounters: new Uint32Array(parsed.dataCounters),
			utilizationChunkAddresses: parsed.utilizationChunkAddresses,
			lastUpdate: parsed.lastUpdate,
		}
	} catch (e) {
		console.error('[BatchUtilization] Failed to load state:', e)
		return undefined
	}
}

/**
 * Clear utilization state from localStorage
 */
export function clearUtilizationState(batchId: BatchId): void {
	const key = `${STORAGE_KEY_PREFIX}${batchId.toHex()}`
	localStorage.removeItem(key)
}

// ============================================================================
// High-level API
// ============================================================================

/**
 * Get or initialize utilization state for a batch
 */
export function getOrInitializeState(batchId: BatchId): BatchUtilizationState {
	const existing = loadUtilizationState(batchId)

	if (existing) {
		return existing
	}

	const newState = initializeBatchUtilization(batchId)
	saveUtilizationState(newState)
	return newState
}

/**
 * Update utilization state after writing data chunks
 *
 * @param batchId - Batch ID
 * @param dataChunks - Data chunks that were written
 * @param batchDepth - Batch depth parameter
 * @returns Updated state and utilization chunks to upload
 */
export function updateAfterWrite(
	batchId: BatchId,
	dataChunks: Chunk[],
	batchDepth: number,
): { state: BatchUtilizationState; utilizationChunks: ChunkWithBucket[] } {
	const currentState = getOrInitializeState(batchId)

	const update = calculateUtilizationUpdate(currentState, dataChunks, batchDepth)

	const newState: BatchUtilizationState = {
		...currentState,
		dataCounters: update.dataCounters,
		utilizationChunkAddresses: update.utilizationChunks.map((c) => c.chunk.address.toString()),
		lastUpdate: Date.now(),
	}

	saveUtilizationState(newState)

	return {
		state: newState,
		utilizationChunks: update.utilizationChunks,
	}
}

/**
 * Calculate current utilization percentage for a batch
 *
 * @param state - Current utilization state
 * @param batchDepth - Batch depth parameter
 * @returns Utilization percentage (0-100)
 */
export function calculateUtilizationPercentage(
	state: BatchUtilizationState,
	batchDepth: number,
): number {
	const maxSlots = calculateMaxSlotsPerBucket(batchDepth)
	const maxBucketUsage = Math.max(...Array.from(state.dataCounters))

	// Utilization is based on the fullest bucket
	return Math.min(100, (maxBucketUsage / maxSlots) * 100)
}

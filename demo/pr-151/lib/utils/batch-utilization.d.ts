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
import { Stamper, BatchId, Topic, Identifier, type Bee, EthAddress, type EnvelopeWithBatchId, type Chunk as BeeChunk } from "@ethersphere/bee-js";
import { type Chunk as CafeChunk } from "cafe-utility";
import type { UtilizationStoreDB } from "../storage/utilization-store";
/** Number of buckets in a postage batch (2^16) */
export declare const NUM_BUCKETS = 65536;
/** Bucket depth parameter (determines bucket count) */
export declare const BUCKET_DEPTH = 16;
/** Number of slots reserved per bucket for utilization chunks (0-3) */
export declare const UTILIZATION_SLOTS_PER_BUCKET = 4;
/** Starting slot index for data chunks */
export declare const DATA_COUNTER_START = 4;
/** Size of each chunk in bytes */
export declare const CHUNK_SIZE = 4096;
/** Batch depth for N=256 slots per bucket with 65536 buckets */
export declare const DEFAULT_BATCH_DEPTH = 24;
/**
 * Metadata for a single utilization chunk
 */
export interface ChunkMetadata {
    /** Chunk index (0-63) */
    index: number;
    /**
     * Content hash / CAC reference (same thing for content-addressed chunks)
     * Empty string means never uploaded
     */
    contentHash: string;
    /** Last upload timestamp */
    lastUpload: number;
    /** Whether this chunk needs uploading */
    dirty: boolean;
}
/**
 * Utilization state for a postage batch
 *
 * This new version stores utilization data as 64 chunks on Swarm
 * with IndexedDB caching for performance.
 */
export interface BatchUtilizationState {
    /** Batch ID this state belongs to */
    batchId: BatchId;
    /** Data counters (65,536 uint32 values) */
    dataCounters: Uint32Array;
    /** Metadata for each of the 64 utilization chunks */
    chunks: ChunkMetadata[];
    /** Topic for SOC storage */
    topic: Topic;
    /** Last sync timestamp */
    lastSync: number;
}
/**
 * Chunk with bucket assignment
 */
export interface ChunkWithBucket {
    chunk: BeeChunk;
    bucket: number;
    slot: number;
}
/**
 * Result of calculating utilization update
 */
export interface UtilizationUpdate {
    /** Updated data counters */
    dataCounters: Uint32Array;
    /** Utilization chunks to upload */
    utilizationChunks: ChunkWithBucket[];
}
/**
 * Calculate which bucket a chunk belongs to based on its address.
 * Uses the first 2 bytes of the chunk address as a big-endian uint16.
 *
 * This matches bee-js Stamper implementation.
 *
 * @param chunkAddress - The chunk's content address (32 bytes)
 * @returns Bucket index (0-65535)
 */
export declare function toBucket(chunkAddress: Uint8Array): number;
/**
 * Calculate bucket assignments for multiple chunks
 */
export declare function assignChunksToBuckets(chunks: BeeChunk[]): ChunkWithBucket[];
/**
 * Number of utilization chunks (64 chunks of 4KB each = 262KB total)
 * Each chunk contains 1,024 buckets (1,024 × 4 bytes = 4,096 bytes)
 */
export declare const NUM_UTILIZATION_CHUNKS = 64;
export declare const BUCKETS_PER_CHUNK = 1024;
/**
 * Calculate which utilization chunk a bucket belongs to
 * @param bucketIndex - Bucket index (0-65535)
 * @returns Chunk index (0-63)
 */
export declare function getChunkIndexForBucket(bucketIndex: number): number;
/**
 * Calculate the offset of a bucket within its chunk
 * @param bucketIndex - Bucket index (0-65535)
 * @returns Offset within chunk (0-1023)
 */
export declare function getBucketOffsetInChunk(bucketIndex: number): number;
/**
 * Extract a 4KB chunk from the dataCounters array
 * @param dataCounters - Full array of 65,536 counters
 * @param chunkIndex - Index of chunk to extract (0-63)
 * @returns 4KB Uint8Array containing serialized counters for this chunk
 */
export declare function extractChunk(dataCounters: Uint32Array, chunkIndex: number): Uint8Array;
/**
 * Merge a 4KB chunk back into the dataCounters array
 * @param dataCounters - Full array of 65,536 counters (modified in place)
 * @param chunkIndex - Index of chunk to merge (0-63)
 * @param chunkData - 4KB Uint8Array containing serialized counters
 */
export declare function mergeChunk(dataCounters: Uint32Array, chunkIndex: number, chunkData: Uint8Array): void;
/**
 * Tracks which utilization chunks have been modified and need uploading
 */
export declare class DirtyChunkTracker {
    private dirtyChunks;
    constructor();
    /**
     * Mark a bucket as dirty (marks its containing chunk)
     * @param bucketIndex - Bucket index (0-65535)
     */
    markDirty(bucketIndex: number): void;
    /**
     * Mark a chunk as clean (uploaded successfully)
     * @param chunkIndex - Chunk index (0-63)
     */
    markClean(chunkIndex: number): void;
    /**
     * Get array of dirty chunk indices
     * @returns Sorted array of chunk indices that need uploading
     */
    getDirtyChunks(): number[];
    /**
     * Check if there are any dirty chunks
     * @returns true if there are chunks waiting to be uploaded
     */
    hasDirtyChunks(): boolean;
    /**
     * Clear all dirty markers
     */
    clear(): void;
    /**
     * Get number of dirty chunks
     * @returns Count of chunks waiting to be uploaded
     */
    get count(): number;
}
/**
 * Create a topic for batch utilization storage
 * Topic format: `batch-utilization:{batchId}`
 *
 * @param batchId - Batch ID
 * @returns Topic for this batch's utilization data
 */
export declare function makeBatchUtilizationTopic(batchId: BatchId): Topic;
/**
 * Create an identifier for a specific utilization chunk
 * Identifier: Keccak256(topic || chunkIndex)
 *
 * @param topic - Batch utilization topic
 * @param chunkIndex - Chunk index (0-63)
 * @returns Identifier for this chunk
 */
export declare function makeChunkIdentifier(topic: Topic, chunkIndex: number): Identifier;
/**
 * Upload an encrypted utilization chunk to Swarm as CAC
 *
 * Architecture: Just upload encrypted chunk data as CAC (immutable)
 *
 * @param bee - Bee client instance
 * @param batchId - Batch ID (for logging)
 * @param postageBatchId - Postage stamp batch ID
 * @param chunkIndex - Chunk index (0-63)
 * @param data - Chunk data to upload (4KB)
 * @param encryptionKey - Encryption key (32 bytes)
 * @returns CAC reference
 */
export declare function uploadUtilizationChunk(bee: Bee, stamper: Stamper, chunkIndex: number, data: Uint8Array, encryptionKey: Uint8Array): Promise<Uint8Array>;
/**
 * Download and decrypt a utilization chunk from Swarm by CAC reference
 *
 * @param bee - Bee client instance
 * @param cacReference - CAC reference (32 bytes)
 * @param chunkIndex - Chunk index (for logging)
 * @param encryptionKey - Encryption key (32 bytes)
 * @returns Decrypted chunk data (4KB) or undefined if not found
 */
export declare function downloadUtilizationChunk(bee: Bee, cacReference: Uint8Array, chunkIndex: number, encryptionKey: Uint8Array): Promise<Uint8Array | undefined>;
/**
 * Serialize Uint32Array to bytes (little-endian)
 */
export declare function serializeUint32Array(arr: Uint32Array): Uint8Array;
/**
 * Deserialize bytes to Uint32Array (little-endian)
 */
export declare function deserializeUint32Array(bytes: Uint8Array): Uint32Array;
/**
 * Split data into 4KB chunks
 */
export declare function splitIntoChunks(data: Uint8Array): BeeChunk[];
/**
 * Reconstruct data from chunks
 */
export declare function reconstructFromChunks(chunks: BeeChunk[], originalLength: number): Uint8Array;
/**
 * Initialize a new batch utilization state
 *
 * Reserves slots 0-3 per bucket for utilization metadata chunks,
 * and starts data chunks at slot 4 (DATA_COUNTER_START).
 *
 * With 65,536 buckets and ~64 utilization chunks, the probability
 * of any bucket getting 4+ utilization chunks is negligible (< 0.0000001%).
 */
export declare function initializeBatchUtilization(batchId: BatchId): BatchUtilizationState;
/**
 * Calculate max slots per bucket based on batch depth
 */
export declare function calculateMaxSlotsPerBucket(batchDepth: number): number;
/**
 * Check if a bucket has capacity for more chunks
 */
export declare function hasBucketCapacity(dataCounter: number, batchDepth: number): boolean;
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
export declare function calculateUtilizationUpdate(state: BatchUtilizationState, dataChunks: BeeChunk[], batchDepth: number): UtilizationUpdate;
/**
 * Create a Stamper with custom bucket state for mutable stamping
 *
 * @param privateKey - Private key for signing
 * @param batchId - Batch ID
 * @param bucketState - Custom bucket heights (for resuming or mutable overwrites)
 * @param batchDepth - Batch depth parameter
 */
export declare function createStamper(privateKey: Uint8Array | string, batchId: BatchId, bucketState: Uint32Array, batchDepth: number): Stamper;
/**
 * Prepare bucket state for stamping chunks with specific slots
 *
 * @param chunksWithBuckets - Chunks with assigned buckets and slots
 * @returns Bucket state array for Stamper
 */
export declare function prepareBucketState(chunksWithBuckets: ChunkWithBucket[]): Uint32Array;
/**
 * Convert utilization data counters to Stamper bucket state
 *
 * Each dataCounter[bucket] represents the number of slots used in that bucket.
 * The Stamper's bucket state should start at the next available slot.
 *
 * @param dataCounters - Current utilization counters (65536 buckets)
 * @returns Bucket state array for Stamper (65536 entries)
 */
export declare function utilizationToBucketState(dataCounters: Uint32Array): Uint32Array;
/**
 * Load utilization state with cache hierarchy
 *
 * Load order:
 * 1. Try IndexedDB cache (all 64 chunks)
 * 2. If incomplete, download missing chunks from Swarm
 * 3. If not found, initialize new state
 * 4. Cache downloaded chunks in IndexedDB
 *
 * @param batchId - Batch ID
 * @param options - Load options with bee, owner, encryption key, and cache
 * @returns Utilization state
 */
export declare function loadUtilizationState(batchId: BatchId, options: {
    bee: Bee;
    owner: EthAddress;
    encryptionKey: Uint8Array;
    cache: UtilizationStoreDB;
}): Promise<BatchUtilizationState>;
/**
 * Save utilization state with incremental upload
 *
 * Only uploads dirty chunks to minimize network traffic.
 * Updates IndexedDB cache with new chunk data.
 *
 * @param state - Current utilization state (modified in place)
 * @param options - Save options
 */
export declare function saveUtilizationState(state: BatchUtilizationState, options: {
    bee: Bee;
    stamper: Stamper;
    encryptionKey: Uint8Array;
    cache: UtilizationStoreDB;
    tracker: DirtyChunkTracker;
}): Promise<void>;
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
export declare function updateAfterWrite(batchId: BatchId, dataChunks: BeeChunk[], batchDepth: number, options: {
    bee: Bee;
    owner: EthAddress;
    encryptionKey: Uint8Array;
    cache: UtilizationStoreDB;
}): Promise<{
    state: BatchUtilizationState;
    tracker: DirtyChunkTracker;
}>;
/**
 * Calculate current utilization percentage for a batch
 *
 * @param state - Current utilization state
 * @param batchDepth - Batch depth parameter
 * @returns Utilization percentage (0-100)
 */
export declare function calculateUtilizationPercentage(state: BatchUtilizationState, batchDepth: number): number;
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
export declare class UtilizationAwareStamper implements Stamper {
    private stamper;
    private utilizationState;
    private cache;
    private dirty;
    private dirtyBuckets;
    readonly batchId: BatchId;
    readonly depth: number;
    get signer(): import("@ethersphere/bee-js").PrivateKey;
    get buckets(): Uint32Array<ArrayBufferLike>;
    get maxSlot(): number;
    private constructor();
    /**
     * Create a UtilizationAwareStamper with bucket state from cache
     *
     * @param privateKey - Signer private key
     * @param batchId - Postage batch ID
     * @param depth - Batch depth
     * @param cache - Utilization cache database
     * @param _owner - Owner address (required for validation, reserved for future Swarm upload)
     * @param _encryptionKey - Encryption key (required for validation, reserved for future Swarm upload)
     * @returns New UtilizationAwareStamper instance
     */
    static create(privateKey: Uint8Array | string, batchId: BatchId, depth: number, cache: UtilizationStoreDB, _owner: EthAddress, _encryptionKey: Uint8Array): Promise<UtilizationAwareStamper>;
    /**
     * Stamp a chunk (implements Stamper interface)
     *
     * Delegates to underlying stamper and tracks which buckets are used.
     *
     * @param chunk - Chunk to stamp
     * @returns Envelope with batch ID and signature
     */
    stamp(chunk: CafeChunk): EnvelopeWithBatchId;
    /**
     * Get bucket state (implements Stamper interface)
     */
    getState(): Uint32Array;
    /**
     * Flush dirty utilization chunks to cache
     *
     * This persists any bucket state changes made during stamping.
     * Should be called after all stamping operations are complete.
     */
    flush(): Promise<void>;
    /**
     * Get current utilization state
     *
     * @returns Current utilization state
     */
    getUtilizationState(): BatchUtilizationState;
}
//# sourceMappingURL=batch-utilization.d.ts.map
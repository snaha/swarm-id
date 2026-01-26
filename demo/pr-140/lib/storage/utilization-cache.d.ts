/**
 * IndexedDB Cache for Batch Utilization Chunks
 *
 * Provides fast local caching of 4KB utilization chunks to avoid
 * repeated Swarm downloads. Each chunk is 4096 bytes containing
 * 1024 bucket counters (uint32).
 */
/**
 * Cache entry for a single utilization chunk
 */
export interface ChunkCacheEntry {
    /** Batch ID (hex string) */
    batchId: string;
    /** Chunk index (0-63) */
    chunkIndex: number;
    /** Serialized chunk data (4KB) */
    data: Uint8Array;
    /** Content hash for change detection */
    contentHash: string;
    /** SOC reference if uploaded to Swarm */
    socReference?: string;
    /** Last access timestamp (for eviction) */
    lastAccess: number;
}
/**
 * Metadata for a batch's utilization state
 */
export interface BatchMetadata {
    batchId: string;
    lastSync: number;
    chunkCount: number;
}
/**
 * Manages IndexedDB cache for batch utilization chunks
 */
export declare class UtilizationCacheDB {
    private db;
    /**
     * Open the IndexedDB database
     */
    open(): Promise<void>;
    /**
     * Get a chunk from cache
     * @param batchId - Batch ID (hex string)
     * @param chunkIndex - Chunk index (0-63)
     * @returns Cache entry or undefined if not found
     */
    getChunk(batchId: string, chunkIndex: number): Promise<ChunkCacheEntry | undefined>;
    /**
     * Store a chunk in cache
     * @param entry - Cache entry to store
     */
    putChunk(entry: ChunkCacheEntry): Promise<void>;
    /**
     * Get all chunks for a batch
     * @param batchId - Batch ID (hex string)
     * @returns Array of cache entries (sorted by chunkIndex)
     */
    getAllChunks(batchId: string): Promise<ChunkCacheEntry[]>;
    /**
     * Clear all chunks for a batch
     * @param batchId - Batch ID (hex string)
     */
    clearBatch(batchId: string): Promise<void>;
    /**
     * Update lastAccess timestamp for a chunk
     * @param batchId - Batch ID (hex string)
     * @param chunkIndex - Chunk index (0-63)
     */
    private touchChunk;
    /**
     * Get batch metadata
     * @param batchId - Batch ID (hex string)
     * @returns Metadata or undefined if not found
     */
    getMetadata(batchId: string): Promise<BatchMetadata | undefined>;
    /**
     * Update batch metadata
     * @param metadata - Metadata to store
     */
    putMetadata(metadata: BatchMetadata): Promise<void>;
    /**
     * Close the database connection
     */
    close(): void;
}
/**
 * Policy for cache eviction
 */
export interface CacheEvictionPolicy {
    /** Maximum age in milliseconds (default: 7 days) */
    maxAge?: number;
    /** Maximum number of chunks to keep (default: 640 = 10 batches) */
    maxChunks?: number;
}
/**
 * Evict old cache entries based on policy
 * @param cache - Cache database instance
 * @param policy - Eviction policy
 */
export declare function evictOldEntries(cache: UtilizationCacheDB, policy?: CacheEvictionPolicy): Promise<void>;
/**
 * Calculate content hash for chunk data
 * @param data - Chunk data (4KB)
 * @returns Hex string hash
 */
export declare function calculateContentHash(data: Uint8Array): string;
//# sourceMappingURL=utilization-cache.d.ts.map
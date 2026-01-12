/**
 * IndexedDB Cache for Batch Utilization Chunks
 *
 * Provides fast local caching of 4KB utilization chunks to avoid
 * repeated Swarm downloads. Each chunk is 4096 bytes containing
 * 1024 bucket counters (uint32).
 */

import { Binary } from "cafe-utility"

// ============================================================================
// Types
// ============================================================================

/**
 * Cache entry for a single utilization chunk
 */
export interface ChunkCacheEntry {
  /** Batch ID (hex string) */
  batchId: string

  /** Chunk index (0-63) */
  chunkIndex: number

  /** Serialized chunk data (4KB) */
  data: Uint8Array

  /** Content hash for change detection */
  contentHash: string

  /** SOC reference if uploaded to Swarm */
  socReference?: string

  /** Last access timestamp (for eviction) */
  lastAccess: number
}

/**
 * Metadata for a batch's utilization state
 */
export interface BatchMetadata {
  batchId: string
  lastSync: number
  chunkCount: number
}

// ============================================================================
// IndexedDB Cache Manager
// ============================================================================

const DB_NAME = "swarm-utilization-cache"
const DB_VERSION = 1
const CHUNKS_STORE = "chunks"
const METADATA_STORE = "metadata"

/**
 * Manages IndexedDB cache for batch utilization chunks
 */
export class UtilizationCacheDB {
  private db: IDBDatabase | undefined

  /**
   * Open the IndexedDB database
   */
  async open(): Promise<void> {
    if (this.db) return

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => {
        reject(new Error(`Failed to open IndexedDB: ${request.error}`))
      }

      request.onsuccess = () => {
        this.db = request.result
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        // Create chunks store with compound key
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          const chunksStore = db.createObjectStore(CHUNKS_STORE, {
            keyPath: ["batchId", "chunkIndex"],
          })

          // Index for querying by batchId
          chunksStore.createIndex("batchId", "batchId", { unique: false })

          // Index for eviction by lastAccess
          chunksStore.createIndex("lastAccess", "lastAccess", {
            unique: false,
          })
        }

        // Create metadata store
        if (!db.objectStoreNames.contains(METADATA_STORE)) {
          db.createObjectStore(METADATA_STORE, { keyPath: "batchId" })
        }
      }
    })
  }

  /**
   * Get a chunk from cache
   * @param batchId - Batch ID (hex string)
   * @param chunkIndex - Chunk index (0-63)
   * @returns Cache entry or undefined if not found
   */
  async getChunk(
    batchId: string,
    chunkIndex: number,
  ): Promise<ChunkCacheEntry | undefined> {
    await this.open()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([CHUNKS_STORE], "readonly")
      const store = transaction.objectStore(CHUNKS_STORE)
      const request = store.get([batchId, chunkIndex])

      request.onsuccess = () => {
        const entry = request.result as ChunkCacheEntry | undefined

        if (entry) {
          // Update lastAccess asynchronously (don't wait)
          this.touchChunk(batchId, chunkIndex).catch((err) => {
            console.warn("[UtilizationCache] Failed to update lastAccess:", err)
          })
        }

        resolve(entry)
      }

      request.onerror = () => {
        reject(new Error(`Failed to get chunk: ${request.error}`))
      }
    })
  }

  /**
   * Store a chunk in cache
   * @param entry - Cache entry to store
   */
  async putChunk(entry: ChunkCacheEntry): Promise<void> {
    await this.open()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([CHUNKS_STORE], "readwrite")
      const store = transaction.objectStore(CHUNKS_STORE)

      // Update lastAccess before storing
      const entryWithAccess = {
        ...entry,
        lastAccess: Date.now(),
      }

      const request = store.put(entryWithAccess)

      request.onsuccess = () => resolve()
      request.onerror = () => {
        reject(new Error(`Failed to put chunk: ${request.error}`))
      }
    })
  }

  /**
   * Get all chunks for a batch
   * @param batchId - Batch ID (hex string)
   * @returns Array of cache entries (sorted by chunkIndex)
   */
  async getAllChunks(batchId: string): Promise<ChunkCacheEntry[]> {
    await this.open()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([CHUNKS_STORE], "readonly")
      const store = transaction.objectStore(CHUNKS_STORE)
      const index = store.index("batchId")
      const request = index.getAll(batchId)

      request.onsuccess = () => {
        const entries = request.result as ChunkCacheEntry[]
        // Sort by chunkIndex for predictable order
        entries.sort((a, b) => a.chunkIndex - b.chunkIndex)
        resolve(entries)
      }

      request.onerror = () => {
        reject(new Error(`Failed to get all chunks: ${request.error}`))
      }
    })
  }

  /**
   * Clear all chunks for a batch
   * @param batchId - Batch ID (hex string)
   */
  async clearBatch(batchId: string): Promise<void> {
    await this.open()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [CHUNKS_STORE, METADATA_STORE],
        "readwrite",
      )
      const chunksStore = transaction.objectStore(CHUNKS_STORE)
      const metadataStore = transaction.objectStore(METADATA_STORE)

      // Delete all chunks for this batch
      const chunksIndex = chunksStore.index("batchId")
      const chunksRequest = chunksIndex.openCursor(batchId)

      chunksRequest.onsuccess = () => {
        const cursor = chunksRequest.result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        }
      }

      // Delete metadata
      metadataStore.delete(batchId)

      transaction.oncomplete = () => resolve()
      transaction.onerror = () => {
        reject(new Error(`Failed to clear batch: ${transaction.error}`))
      }
    })
  }

  /**
   * Update lastAccess timestamp for a chunk
   * @param batchId - Batch ID (hex string)
   * @param chunkIndex - Chunk index (0-63)
   */
  private async touchChunk(batchId: string, chunkIndex: number): Promise<void> {
    await this.open()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([CHUNKS_STORE], "readwrite")
      const store = transaction.objectStore(CHUNKS_STORE)
      const request = store.get([batchId, chunkIndex])

      request.onsuccess = () => {
        const entry = request.result as ChunkCacheEntry | undefined
        if (entry) {
          entry.lastAccess = Date.now()
          store.put(entry)
        }
      }

      transaction.oncomplete = () => resolve()
      transaction.onerror = () => {
        reject(new Error(`Failed to touch chunk: ${transaction.error}`))
      }
    })
  }

  /**
   * Get batch metadata
   * @param batchId - Batch ID (hex string)
   * @returns Metadata or undefined if not found
   */
  async getMetadata(batchId: string): Promise<BatchMetadata | undefined> {
    await this.open()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([METADATA_STORE], "readonly")
      const store = transaction.objectStore(METADATA_STORE)
      const request = store.get(batchId)

      request.onsuccess = () =>
        resolve(request.result as BatchMetadata | undefined)
      request.onerror = () => {
        reject(new Error(`Failed to get metadata: ${request.error}`))
      }
    })
  }

  /**
   * Update batch metadata
   * @param metadata - Metadata to store
   */
  async putMetadata(metadata: BatchMetadata): Promise<void> {
    await this.open()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([METADATA_STORE], "readwrite")
      const store = transaction.objectStore(METADATA_STORE)
      const request = store.put(metadata)

      request.onsuccess = () => resolve()
      request.onerror = () => {
        reject(new Error(`Failed to put metadata: ${request.error}`))
      }
    })
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = undefined
    }
  }
}

// ============================================================================
// Cache Eviction
// ============================================================================

/**
 * Policy for cache eviction
 */
export interface CacheEvictionPolicy {
  /** Maximum age in milliseconds (default: 7 days) */
  maxAge?: number

  /** Maximum number of chunks to keep (default: 640 = 10 batches) */
  maxChunks?: number
}

/**
 * Evict old cache entries based on policy
 * @param cache - Cache database instance
 * @param policy - Eviction policy
 */
export async function evictOldEntries(
  cache: UtilizationCacheDB,
  policy: CacheEvictionPolicy = {},
): Promise<void> {
  const maxAge = policy.maxAge ?? 7 * 24 * 60 * 60 * 1000 // 7 days
  const maxChunks = policy.maxChunks ?? 640 // 10 batches × 64 chunks

  await cache.open()

  const db = (cache as never)["db"] as IDBDatabase

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CHUNKS_STORE], "readwrite")
    const store = transaction.objectStore(CHUNKS_STORE)
    const index = store.index("lastAccess")

    const oldestAllowed = Date.now() - maxAge
    const entries: Array<{ key: IDBValidKey; lastAccess: number }> = []

    // Collect all entries with their lastAccess times
    const request = index.openCursor()

    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) {
        const entry = cursor.value as ChunkCacheEntry
        entries.push({
          key: cursor.primaryKey,
          lastAccess: entry.lastAccess,
        })
        cursor.continue()
      } else {
        // All entries collected, now evict
        // 1. Delete entries older than maxAge
        for (const entry of entries) {
          if (entry.lastAccess < oldestAllowed) {
            store.delete(entry.key)
          }
        }

        // 2. If still over maxChunks, delete oldest entries
        if (entries.length > maxChunks) {
          entries.sort((a, b) => a.lastAccess - b.lastAccess)
          const toDelete = entries.slice(0, entries.length - maxChunks)
          for (const entry of toDelete) {
            store.delete(entry.key)
          }
        }
      }
    }

    transaction.oncomplete = () => resolve()
    transaction.onerror = () => {
      reject(new Error(`Failed to evict entries: ${transaction.error}`))
    }
  })
}

/**
 * Calculate content hash for chunk data
 * @param data - Chunk data (4KB)
 * @returns Hex string hash
 */
export function calculateContentHash(data: Uint8Array): string {
  const hash = Binary.keccak256(data)
  return Binary.uint8ArrayToHex(hash)
}

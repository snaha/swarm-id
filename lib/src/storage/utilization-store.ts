// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * IndexedDB Cache for Batch Utilization Chunks
 *
 * Provides fast local caching of 4KB utilization chunks to avoid
 * repeated Swarm downloads. Each chunk is 4096 bytes holding 1024 uint32
 * bucket counters, whatever the batch depth.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Cache entry for a single utilization chunk
 */
export interface ChunkCacheEntry {
  /** Batch ID (hex string) */
  batchId: string

  /** Chunk index within the fixed cache layout */
  chunkIndex: number

  /** Serialized chunk data (4KB) */
  data: Uint8Array

  /** Content hash for change detection */
  contentHash: string

  /** SOC reference if uploaded to Swarm */
  socReference?: string

  /**
   * Per-chunk-index encryption nonce that was used to derive this chunk's
   * encryption key. Lets a re-save start its bucket-collision search from
   * the previously-chosen value, so unchanged plaintexts keep the same
   * derived key (and therefore the same `contentHash`) across saves.
   *
   * Required: every row is written by a bundle that sets it, and an upgrade
   * drops the stores rather than carrying rows forward (#662).
   */
  nonce: number

  /**
   * `CACHE_ROW_FORMAT` on every row the fixed layout writes. A row without it
   * predates #463 and is still at its batch's depth-of-the-time layout; the
   * stamper converts such a batch on load rather than the store dropping it.
   */
  format?: number

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
  /**
   * Per-partition "synced reference": the partition-state reference chunk
   * (hex) this device's local counter was last in sync with. On a cold
   * acquire, if the state pointer still names it the leaf downloads are
   * skipped and the local counter reused. Keyed by partition index.
   */
  stateReferences?: Record<number, string>
  /**
   * What a pre-v2 build stored in place of `stateReferences` (#463): v1
   * reference chunks no v2 reader can parse, so never a heartbeat target — one
   * adopted as such would leave the partition `readFailed` to every other
   * device's takeover. An entry still says this device wrote the lane, so a
   * cold claim that finds no v2 state resumes from the converted cache rows
   * rather than from zero. The first v2 publish of a partition drops its entry.
   */
  syncedReferences?: Record<number, string>
  /**
   * Per-partition buckets occupied by the LATEST published partition-state
   * chunks (counter chunks + reference chunk). Those chunks overstamp the
   * partition's reserved slot in their buckets, so utilization saves must
   * avoid placing chunks there — a collision would evict the published
   * state from the reserve (Bee replaces the older chunk at a colliding
   * stamp index), and a later takeover would fail to read its resume point.
   * Keyed by partition index; replaced wholesale on every publish/read.
   */
  stateChunkBuckets?: Record<number, number[]>
}

// ============================================================================
// IndexedDB Cache Manager
// ============================================================================

const DB_NAME = "swarm-utilization-store"
/**
 * Bumped whenever a stored row's shape changes, because an upgrade DROPS the
 * stores rather than migrating them: this is a cache of utilisation counters
 * that re-derives itself on next use, and 0.x owes no migration (#661).
 */
const DB_VERSION = 4
const CHUNKS_STORE = "chunks"
const METADATA_STORE = "metadata"

/**
 * Manages IndexedDB cache for batch utilization chunks
 */
export class UtilizationStoreDB {
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

      // Fires when an upgrade is held up by another open connection (e.g.
      // a second tab on the trusted domain). The upgrade proceeds once that
      // connection closes — see the onversionchange handler below.
      request.onblocked = () => {
        console.warn(
          "[UtilizationStore] IndexedDB upgrade blocked by another open connection; waiting for it to close",
        )
      }

      request.onsuccess = () => {
        this.db = request.result
        // Release this connection if another tab needs to upgrade, so its
        // open() does not block indefinitely on us.
        this.db.onversionchange = () => {
          this.close()
        }
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        // Any upgrade drops and recreates: rows from an older version are not
        // migrated, and utilization tracking re-initializes to defaults on next
        // use. See `DB_VERSION`.
        if (db.objectStoreNames.contains(CHUNKS_STORE)) {
          db.deleteObjectStore(CHUNKS_STORE)
        }
        if (db.objectStoreNames.contains(METADATA_STORE)) {
          db.deleteObjectStore(METADATA_STORE)
        }

        const chunksStore = db.createObjectStore(CHUNKS_STORE, {
          keyPath: ["batchId", "chunkIndex"],
        })

        // Index for querying by batchId
        chunksStore.createIndex("batchId", "batchId", { unique: false })

        // Metadata store
        db.createObjectStore(METADATA_STORE, { keyPath: "batchId" })
      }
    })
  }

  /**
   * Get a chunk from cache
   * @param batchId - Batch ID (hex string)
   * @param chunkIndex - Chunk index
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
            console.warn("[UtilizationStore] Failed to update lastAccess:", err)
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
   * Read a batch's rows and, when `convert` returns replacements, swap them in
   * within the same readwrite transaction (#463). IndexedDB commits all of it
   * or none, and serializes overlapping readwrite transactions, so a closed
   * tab leaves the old rows whole and a second tab converting at the same
   * time sees either the old rows or the converted ones, never a mix.
   *
   * @returns The batch's rows as they stand once the transaction commits
   *          (sorted by chunkIndex)
   */
  async convertBatch(
    batchId: string,
    convert: (rows: ChunkCacheEntry[]) => ChunkCacheEntry[] | undefined,
  ): Promise<ChunkCacheEntry[]> {
    await this.open()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([CHUNKS_STORE], "readwrite")
      const store = transaction.objectStore(CHUNKS_STORE)
      let result: ChunkCacheEntry[] = []
      const request = store.index("batchId").getAll(batchId)
      request.onsuccess = () => {
        const rows = (request.result as ChunkCacheEntry[]).sort(
          (a, b) => a.chunkIndex - b.chunkIndex,
        )
        result = rows
        let replacement: ChunkCacheEntry[] | undefined
        try {
          replacement = convert(rows)
          if (!replacement) return
          for (const row of rows) store.delete([batchId, row.chunkIndex])
          for (const row of replacement) store.put(row)
        } catch (error) {
          // Abort rather than commit the writes issued so far
          transaction.abort()
          reject(error)
          return
        }
        result = [...replacement].sort((a, b) => a.chunkIndex - b.chunkIndex)
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () =>
        reject(new Error(`Batch conversion aborted: ${transaction.error}`))
      transaction.onerror = () =>
        reject(new Error(`Batch conversion failed: ${transaction.error}`))
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
   * @param chunkIndex - Chunk index
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

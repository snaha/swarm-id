// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * IndexedDB Cache for Batch Utilization Chunks
 *
 * Provides fast local caching of 4KB utilization chunks to avoid
 * repeated Swarm downloads. Each chunk is 4096 bytes holding 1024 uint32
 * bucket counters, whatever the batch depth or the batch's wire format (#463).
 */

import type { PartitionLeaseStateSnapshot } from "../sync/partition-lease"

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

  /** Last access timestamp (for eviction) */
  lastAccess: number
}

/**
 * Metadata for a batch's utilization state
 */
export interface BatchMetadata {
  batchId: string
  /**
   * The v2 partition-state reference chunk (hex) this device's cache rows were
   * last in sync with, and the lane it belongs to. On a cold acquire of that
   * lane, if the state pointer still names it the leaf downloads are skipped
   * and the local counter reused. One, not one per partition: the rows hold a
   * single lane's counter (`bindPartition` replaces the table), so a reference
   * certifies them for that lane only, and only while `rowsPartition` agrees.
   * `exact` while the rows hold precisely the counter the reference names;
   * false once data rows were flushed past it with no publish to name them.
   */
  stateReference?: { partition: number; referenceHex: string; exact: boolean }
  /**
   * The lane the cache rows describe. Cleared before a flush that rewrites
   * them for another lane and set again after it, so a tab that dies midway
   * leaves rows no reference certifies — a cache miss on the next claim, never
   * a table mixing two lanes. Undefined until the first flush after a bind.
   */
  rowsPartition?: number
  /**
   * Bumped by a flush before its first row and again after its last. The rows
   * are shared by every tab of the storage partition; a stamper whose
   * last-seen generation is not this one knows another tab wrote them since
   * (or is writing them now), and folds them into its table.
   */
  rowsGeneration?: number
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
  /**
   * The lease this storage partition holds on the drive, per account id:
   * which lane, under which claim, until when, and the reference of its
   * latest publish. Every tab of the partition is the same device to the
   * lease protocol and reads its lease from here (`leaseRecordIn`). Per
   * account because the store is keyed by batch alone, and a lease belongs to
   * an account's lock SOCs.
   */
  leases?: Record<string, PartitionLeaseStateSnapshot>
}

/**
 * One drive's lease record, as a context reads and writes it. `update` is one
 * atomic step, so two tabs changing the record cannot undo each other.
 */
export interface LeaseRecordStore {
  read(): Promise<PartitionLeaseStateSnapshot | undefined>
  update(
    next: (
      existing: PartitionLeaseStateSnapshot | undefined,
    ) => PartitionLeaseStateSnapshot | undefined,
  ): Promise<void>
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
const DB_VERSION = 5
const CHUNKS_STORE = "chunks"
const METADATA_STORE = "metadata"

/**
 * The store could not be opened at all: IndexedDB is missing or refused the
 * database. No rows can exist behind this error, so a stamper may start from
 * zero; any other error means rows may exist and were not read.
 */
export class UtilizationStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UtilizationStoreUnavailableError"
  }
}

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
      if (typeof indexedDB === "undefined") {
        reject(new UtilizationStoreUnavailableError("IndexedDB is unavailable"))
        return
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => {
        reject(
          new UtilizationStoreUnavailableError(
            `Failed to open IndexedDB: ${request.error}`,
          ),
        )
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
   * Merge what `patch` returns into a batch's metadata record, in one
   * `readwrite` transaction. The record is one object with several fields
   * and more than one writer; a read-then-put in two transactions lets a
   * concurrent writer put back the field this one just changed, so every
   * writer goes through here and names only what it changes.
   */
  async updateMetadata(
    batchId: string,
    patch: (existing: BatchMetadata | undefined) => Partial<BatchMetadata>,
  ): Promise<void> {
    await this.open()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([METADATA_STORE], "readwrite")
      const store = transaction.objectStore(METADATA_STORE)
      const read = store.get(batchId)
      read.onerror = () => {
        reject(new Error(`Failed to get metadata: ${read.error}`))
      }
      read.onsuccess = () => {
        const existing = read.result as BatchMetadata | undefined
        let next: BatchMetadata
        try {
          next = { ...existing, ...patch(existing), batchId }
        } catch (error) {
          // Thrown inside an IndexedDB callback the error would be lost to the
          // event loop and the transaction aborted with no `error` of its own
          reject(error)
          transaction.abort()
          return
        }
        const write = store.put(next)
        write.onerror = () => {
          reject(new Error(`Failed to put metadata: ${write.error}`))
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = transaction.onerror = () => {
        reject(new Error(`Failed to update metadata: ${transaction.error}`))
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

/**
 * The lease record of `accountId` on `batchId` in `store`. A store that
 * cannot be opened holds no record and keeps none: reads are empty and writes
 * are dropped, so a context without IndexedDB runs from memory.
 */
export function leaseRecordIn(
  store: UtilizationStoreDB,
  batchId: string,
  accountId: string,
): LeaseRecordStore {
  const account = accountId.toLowerCase()
  const unlessUnavailable = (error: unknown): undefined => {
    if (error instanceof UtilizationStoreUnavailableError) return undefined
    throw error
  }
  return {
    read: () =>
      store
        .getMetadata(batchId)
        .then((metadata) => metadata?.leases?.[account], unlessUnavailable),
    update: (next) =>
      store
        .updateMetadata(batchId, (existing) => {
          const { [account]: mine, ...others } = existing?.leases ?? {}
          const snapshot = next(mine)
          return {
            leases: snapshot ? { ...others, [account]: snapshot } : others,
          }
        })
        .catch(unlessUnavailable),
  }
}

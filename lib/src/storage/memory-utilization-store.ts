// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  BatchMetadata,
  ChunkCacheEntry,
  UtilizationStoreDB,
} from "./utilization-store"

/**
 * An in-memory stand-in for `UtilizationStoreDB` with the same contract, for
 * tests that have no IndexedDB: rows and metadata per batch, `updateMetadata`
 * as one atomic patch, `writeRows` all or nothing. A test injects a failure
 * by wrapping the method it wants to fail.
 */
export function memoryUtilizationStore(
  seed: ChunkCacheEntry[] = [],
): UtilizationStoreDB {
  const rows = new Map<string, ChunkCacheEntry>()
  const metadata = new Map<string, BatchMetadata>()
  const key = (batchId: string, chunkIndex: number) =>
    `${batchId}:${chunkIndex}`
  for (const row of seed) rows.set(key(row.batchId, row.chunkIndex), { ...row })
  const patched = (
    batchId: string,
    patch: (existing: BatchMetadata | undefined) => Partial<BatchMetadata>,
  ): BatchMetadata => {
    const existing = metadata.get(batchId)
    return { ...existing, ...patch(existing), batchId }
  }
  return {
    getAllChunks: async (batchId: string) =>
      [...rows.values()]
        .filter((row) => row.batchId === batchId)
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map((row) => ({ ...row })),
    getChunk: async (batchId: string, chunkIndex: number) =>
      rows.get(key(batchId, chunkIndex)),
    putChunk: async (entry: ChunkCacheEntry) => {
      rows.set(key(entry.batchId, entry.chunkIndex), { ...entry })
    },
    getMetadata: async (batchId: string) => metadata.get(batchId),
    updateMetadata: async (
      batchId: string,
      patch: (existing: BatchMetadata | undefined) => Partial<BatchMetadata>,
    ) => {
      metadata.set(batchId, patched(batchId, patch))
    },
    writeRows: async (
      batchId: string,
      entries: ChunkCacheEntry[],
      patch: (existing: BatchMetadata | undefined) => Partial<BatchMetadata>,
    ) => {
      // The patch runs first: when it throws, nothing has been written
      const next = patched(batchId, patch)
      for (const entry of entries) {
        rows.set(key(entry.batchId, entry.chunkIndex), { ...entry })
      }
      metadata.set(batchId, next)
    },
  } as unknown as UtilizationStoreDB
}

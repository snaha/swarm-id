// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Constants
export const CHUNK_SIZE = 4096
export const PLAIN_REFS_PER_CHUNK = 128 // 4096 / 32 = 128 plain (unencrypted) refs per intermediate chunk
export const ENCRYPTED_REFS_PER_CHUNK = 64 // 4096 / 64 = 64 encrypted refs per intermediate chunk

/**
 * Estimate total chunks for progress tracking
 * This is an approximation based on span. The branching factor depends on
 * the reference width: 128 refs per intermediate for plain trees (32-byte
 * refs), 64 for encrypted trees (64-byte refs).
 */
export function estimateTotalChunks(
  span: number,
  refsPerChunk: number,
): number {
  if (span <= CHUNK_SIZE) {
    return 1
  }

  // Number of leaf chunks
  const leafChunks = Math.ceil(span / CHUNK_SIZE)

  // Intermediate chunks for a tree with refsPerChunk-way branching
  // This is a rough estimate - actual count depends on tree structure
  let intermediateChunks = 0
  let level = leafChunks
  while (level > 1) {
    level = Math.ceil(level / refsPerChunk)
    intermediateChunks += level
  }

  return leafChunks + intermediateChunks
}

/**
 * Split data into 4096-byte chunks
 */
export function splitDataIntoChunks(data: Uint8Array): Uint8Array[] {
  // Zero-length content is a single empty chunk (span 0) — Bee's canonical
  // representation of an empty file.
  if (data.length === 0) {
    return [new Uint8Array(0)]
  }
  const chunks: Uint8Array[] = []
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    chunks.push(data.slice(i, Math.min(i + CHUNK_SIZE, data.length)))
  }
  return chunks
}

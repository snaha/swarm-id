// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Constants
export const CHUNK_SIZE = 4096
export const PLAIN_REFS_PER_CHUNK = 128 // 4096 / 32 = 128 plain (unencrypted) refs per intermediate chunk
export const ENCRYPTED_REFS_PER_CHUNK = 64 // 4096 / 64 = 64 encrypted refs per intermediate chunk
/** The most bytes one message of a streaming upload or download carries. */
export const STREAM_PIECE_SIZE = 256 * 1024

/**
 * Chunks a file of `span` bytes splits into, for upload progress and drive
 * capacity. The branching factor depends on the reference width: 128 refs per
 * intermediate for plain trees (32-byte refs), 64 for encrypted trees (64-byte
 * refs). It ignores the carry of a lone last reference into the level above,
 * so it can overcount by a chunk per level, never undercount.
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
  let intermediateChunks = 0
  let level = leafChunks
  while (level > 1) {
    level = Math.ceil(level / refsPerChunk)
    intermediateChunks += level
  }

  return leafChunks + intermediateChunks
}

/**
 * Re-cut a stream of byte pieces into blocks of exactly `size`, the last one
 * shorter if the bytes run out. Holds at most one block, and yields one the
 * caller may keep. Nothing in, nothing out.
 */
export async function* rechunk(
  source: AsyncIterable<Uint8Array>,
  size: number,
): AsyncGenerator<Uint8Array> {
  let block = new Uint8Array(size)
  let filled = 0
  for await (const piece of source) {
    let offset = 0
    while (offset < piece.length) {
      const taken = Math.min(size - filled, piece.length - offset)
      block.set(piece.subarray(offset, offset + taken), filled)
      filled += taken
      offset += taken
      if (filled === size) {
        yield block
        block = new Uint8Array(size)
        filled = 0
      }
    }
  }
  if (filled > 0) yield block.slice(0, filled)
}

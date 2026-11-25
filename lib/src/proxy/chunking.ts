// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getMaxShards, getParities } from "@ethersphere/core-sdk"

// Constants
export const CHUNK_SIZE = 4096
export const PLAIN_REFS_PER_CHUNK = 128 // 4096 / 32 = 128 plain (unencrypted) refs per intermediate chunk
export const ENCRYPTED_REFS_PER_CHUNK = 64 // 4096 / 64 = 64 encrypted refs per intermediate chunk

/**
 * Root replicas Bee spreads per redundancy level (`replicas.Counts`), each a
 * stamped chunk of its own. core-sdk's `makeReplicas` makes them but does not
 * export the counts.
 */
const REPLICA_COUNTS = [0, 2, 4, 8, 16]

/**
 * Chunks a file of `span` bytes is uploaded as, for upload progress and drive
 * capacity: leaves, intermediates and, at a redundancy level above 0, every
 * batch's Reed-Solomon parity and the root's replicas. It ignores the carry of
 * a lone last reference into the level above, so it can overcount by a chunk
 * (and its parity) per level, never undercount.
 */
export function estimateTotalChunks(
  span: number,
  encrypted: boolean,
  redundancyLevel = 0,
): number {
  const fanout = getMaxShards(redundancyLevel, encrypted)
  const parities = (shards: number) =>
    getParities(redundancyLevel, shards, encrypted)
  let total = 1 + REPLICA_COUNTS[redundancyLevel]
  let nodes = Math.max(1, Math.ceil(span / CHUNK_SIZE))
  while (nodes > 1) {
    const rest = nodes % fanout
    total +=
      nodes +
      Math.floor(nodes / fanout) * parities(fanout) +
      (rest > 0 ? parities(rest) : 0)
    nodes = Math.ceil(nodes / fanout)
  }
  return total
}

/**
 * Re-cut a stream of byte pieces into blocks of exactly `size`, the last one
 * shorter if the bytes run out. Holds at most one block, and yields one the
 * caller may keep. Nothing in, nothing out.
 */
export async function* rechunk(
  source: AsyncIterable<Uint8Array>,
  size: number,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
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

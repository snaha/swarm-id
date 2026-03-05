/**
 * Shared utilities for epoch feed finders
 */

import { EpochIndex } from "./epoch"

const MAX_LEAF_BACKSCAN = 128n

/**
 * Type for the chunk fetcher callback used by findPreviousLeaf.
 * This allows both sync and async finders to share the same logic.
 */
export type EpochChunkFetcher = (
  at: bigint,
  epoch: EpochIndex,
) => Promise<Uint8Array | undefined>

/**
 * Find a previous leaf chunk by scanning backwards from the target timestamp.
 *
 * This is a recovery fallback for poisoned-ancestor histories where the tree
 * traversal fails but valid leaf nodes exist.
 *
 * @param at - Target unix timestamp (seconds)
 * @param after - Hint of latest known update timestamp (0 if unknown)
 * @param getEpochChunk - Callback function to fetch epoch chunks
 * @returns 32-byte Swarm reference, or undefined if no update found
 */
export async function findPreviousLeaf(
  at: bigint,
  after: bigint,
  getEpochChunk: EpochChunkFetcher,
): Promise<Uint8Array | undefined> {
  if (at === 0n) {
    return undefined
  }

  const minAt = after > 0n ? after : 0n
  const lowerBound =
    at > MAX_LEAF_BACKSCAN && at - MAX_LEAF_BACKSCAN > minAt
      ? at - MAX_LEAF_BACKSCAN
      : minAt

  let probe = at - 1n
  while (probe >= lowerBound) {
    try {
      const leaf = await getEpochChunk(at, new EpochIndex(probe, 0))
      if (leaf) {
        return leaf
      }
    } catch {
      // Missing leaf at probe timestamp.
    }

    if (probe === 0n) {
      break
    }
    probe--
  }

  return undefined
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synchronous Epoch Feed Finder
 *
 * Recursive implementation for finding feed updates at specific timestamps
 * using epoch-based indexing.
 */

import { EthAddress, Topic } from "@ethersphere/bee-js"
import type { ChunkDownloader } from "../../download-data"
import { EpochIndex, lca, MAX_LEVEL } from "./epoch"
import type { EpochFinder } from "./types"
import { fetchEpochEntry, findPreviousLeaf } from "./utils"

/**
 * Synchronous recursive finder for epoch-based feeds
 *
 * Traverses the epoch tree recursively to find the feed update
 * valid at a specific timestamp.
 *
 * Implements the EpochFinder interface.
 */
export class SyncEpochFinder implements EpochFinder {
  constructor(
    private readonly bee: ChunkDownloader,
    private readonly topic: Topic,
    private readonly owner: EthAddress,
  ) {}

  /**
   * Find the feed update valid at time `at`
   * @param at - Target unix timestamp (seconds)
   * @param after - Hint of latest known update timestamp (0 if unknown)
   * @returns 32-byte Swarm reference, or undefined if no update found
   */
  async findAt(
    at: bigint,
    after: bigint = 0n,
  ): Promise<Uint8Array | undefined> {
    // Fast path: exact timestamp updates are written at level-0 and should be
    // retrievable without traversing potentially poisoned ancestors.
    const exactEpoch = new EpochIndex(at, 0)
    try {
      const exact = await this.getEpochChunk(at, exactEpoch)
      if (exact) {
        return exact
      }
    } catch {
      // Ignore and fall back to standard traversal.
    }

    const { epoch, chunk } = await this.common(at, after)

    if (!chunk && epoch.level === MAX_LEVEL) {
      // No update found at all
      return undefined
    }

    const traversed = await this.atEpoch(at, epoch, chunk)
    if (traversed) {
      return traversed
    }

    // Recovery fallback for poisoned-ancestor histories: only enable bounded
    // leaf back-scan when root epoch exists but is invalid for `at`.
    try {
      const rootProbe = await this.getEpochChunk(
        at,
        new EpochIndex(0n, MAX_LEVEL),
      )
      if (rootProbe === undefined) {
        return this.findPreviousLeaf(at, after)
      }
    } catch {
      // Root missing - no evidence of poisoned ancestors.
    }

    return undefined
  }

  /**
   * Find the lowest common ancestor epoch with an existing chunk
   *
   * Traverses UP the epoch tree from the LCA until finding a chunk,
   * or reaching the top level.
   *
   * @param at - Target timestamp
   * @param after - Reference timestamp
   * @returns Epoch and chunk found at that epoch (if any)
   */
  private async common(
    at: bigint,
    after: bigint,
  ): Promise<{ epoch: EpochIndex; chunk?: Uint8Array }> {
    let epoch = lca(at, after)

    while (true) {
      try {
        const chunk = await this.getEpochChunk(at, epoch)

        // getEpochChunk validates timestamp and returns undefined if invalid
        if (chunk) {
          return { epoch, chunk }
        }

        // Chunk found but timestamp invalid, continue searching up
      } catch {
        // Chunk not found, continue searching up
      }

      // Check if at top before trying to go to parent
      if (epoch.level === MAX_LEVEL) {
        // Reached top without finding anything
        return { epoch }
      }

      // Move to parent epoch
      epoch = epoch.parent()
    }
  }

  /**
   * Recursive descent to find exact update at timestamp
   *
   * Traverses DOWN the epoch tree, handling left/right branches
   * to find the most recent update not later than `at`.
   *
   * @param at - Target timestamp
   * @param epoch - Current epoch being examined
   * @param currentChunk - Best chunk found so far
   * @returns Final chunk reference, or undefined
   */
  private async atEpoch(
    at: bigint,
    epoch: EpochIndex,
    currentChunk?: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    let chunk: Uint8Array | undefined

    try {
      chunk = await this.getEpochChunk(at, epoch)
    } catch {
      // Epoch chunk not found
      if (epoch.isLeft()) {
        // No lower resolution available, return what we have
        return currentChunk
      }

      // Traverse earlier branch (left sibling)
      return this.atEpoch(epoch.start - 1n, epoch.left(), currentChunk)
    }

    // Chunk validation (timestamp) is handled by getEpochChunk
    if (!chunk) {
      // Timestamp invalid (update too recent)
      if (epoch.level > 0) {
        const down = await this.atEpoch(at, epoch.childAt(at), currentChunk)
        if (down) {
          return down
        }
      }
      if (epoch.isLeft()) {
        return currentChunk
      }

      // Traverse earlier branch
      return this.atEpoch(epoch.start - 1n, epoch.left(), currentChunk)
    }

    // Update is valid
    if (epoch.level === 0) {
      // Finest resolution - this is our answer
      return chunk
    }

    // Continue traversing down to finer resolution
    return this.atEpoch(at, epoch.childAt(at), chunk)
  }

  /**
   * Fetch chunk for a specific epoch
   *
   * @param at - Target timestamp for validation
   * @param epoch - Epoch to fetch
   * @returns Chunk reference (32 or 64 bytes), or undefined if timestamp invalid
   * @throws Error if chunk not found, not signed by the owner, or network error
   */
  private async getEpochChunk(
    at: bigint,
    epoch: EpochIndex,
  ): Promise<Uint8Array | undefined> {
    const entry = await fetchEpochEntry(
      this.bee,
      this.topic,
      this.owner,
      epoch,
      at,
    )
    return entry?.reference
  }

  private findPreviousLeaf(
    at: bigint,
    after: bigint,
  ): Promise<Uint8Array | undefined> {
    return findPreviousLeaf(at, after, (targetAt, epoch) =>
      this.getEpochChunk(targetAt, epoch),
    )
  }
}

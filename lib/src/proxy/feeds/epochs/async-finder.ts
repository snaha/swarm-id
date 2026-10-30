// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Async Epoch Feed Finder (Concurrent)
 *
 * Concurrent implementation for finding feed updates at specific timestamps
 * using epoch-based indexing with parallel chunk fetching.
 */

import { EthAddress, Topic } from "@ethersphere/bee-js"
import type { ChunkDownloader } from "../../download-data"
import { EpochIndex, MAX_LEVEL } from "./epoch"
import type { EpochFinder, EpochLookupResult } from "./types"
import { fetchEpochEntry, findPreviousLeaf, type EpochEntry } from "./utils"

/**
 * Async concurrent finder for epoch-based feeds
 *
 * Launches parallel chunk fetches along the epoch tree path
 * to find the feed update valid at a specific timestamp.
 *
 * Implements the EpochFinder interface.
 */
export class AsyncEpochFinder implements EpochFinder {
  constructor(
    private readonly bee: ChunkDownloader,
    private readonly topic: Topic,
    private readonly owner: EthAddress,
    private readonly encryptionKey?: Uint8Array,
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
    // retrievable without traversing potentially poisoned ancestors. It runs
    // CONCURRENTLY with the traversal (#400): on a "latest as of now" read
    // (every account fold) the exact probe virtually never hits, and awaiting
    // it first serialised a full absent-chunk timeout before the traversal even
    // started. Both are awaited — not raced — because an exact hit must win
    // even when the traversal returns nothing (that IS the poisoned-ancestor
    // recovery this fast path exists for).
    const exactProbe = this.getEpochChunk(at, new EpochIndex(at, 0)).catch(
      () => undefined,
    )
    const [exact, traversed] = await Promise.all([
      exactProbe,
      this.findAtEpoch(at, new EpochIndex(0n, MAX_LEVEL), undefined),
    ])
    if (exact) {
      return exact
    }
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
   * Recursively find update at epoch, with parallel fetching
   *
   * @param at - Target timestamp
   * @param epoch - Current epoch to check
   * @param currentBest - Best result found so far
   * @returns Reference if found, undefined otherwise
   */
  private async findAtEpoch(
    at: bigint,
    epoch: EpochIndex,
    currentBest: Uint8Array | undefined,
  ): Promise<Uint8Array | undefined> {
    // Try to get chunk at this epoch.
    // getEpochChunk throws when chunk is missing, returns undefined when
    // chunk exists but timestamp is invalid for `at`.
    let chunk: Uint8Array | undefined
    try {
      chunk = await this.getEpochChunk(at, epoch)
    } catch {
      // Chunk missing at this epoch.
      if (epoch.isLeft()) {
        return currentBest
      }
      return this.findAtEpoch(epoch.start - 1n, epoch.left(), currentBest)
    }

    // If chunk found and valid
    if (chunk) {
      // If at finest resolution, this is our answer
      if (epoch.level === 0) {
        return chunk
      }

      // Continue to finer resolution
      return this.findAtEpoch(at, epoch.childAt(at), chunk)
    }

    // Chunk exists but timestamp invalid.
    // Keep descending towards the target epoch first, because finer epochs
    // may still contain a valid update.
    if (epoch.level > 0) {
      const down = await this.findAtEpoch(at, epoch.childAt(at), currentBest)
      if (down) {
        return down
      }
    }

    if (epoch.isLeft()) {
      // Left child - return best we have so far
      return currentBest
    }

    // Right child - need to search left sibling branch
    return this.findAtEpoch(epoch.start - 1n, epoch.left(), currentBest)
  }
  /**
   * Fetch chunk for a specific epoch
   *
   * @param at - Target timestamp for validation
   * @param epoch - Epoch to fetch
   * @returns Chunk payload
   * @throws Error if chunk not found
   */
  private async getEpochChunk(
    at: bigint,
    epoch: EpochIndex,
  ): Promise<Uint8Array | undefined> {
    const result = await this.getEpochChunkWithMetadata(at, epoch)
    return result?.reference
  }

  /**
   * Find the feed update valid at time `at` with full metadata
   * Used by updater to calculate next epoch when no hints provided
   *
   * @param at - Target unix timestamp (seconds)
   * @returns EpochLookupResult with reference, epoch, and timestamp, or undefined if no update found
   */
  async findAtWithMetadata(at: bigint): Promise<EpochLookupResult | undefined> {
    // Fast path: exact timestamp updates are written at level-0
    const exactEpoch = new EpochIndex(at, 0)
    try {
      const exact = await this.getEpochChunkWithMetadata(at, exactEpoch)
      if (exact) {
        return {
          reference: exact.reference,
          epoch: exactEpoch,
          timestamp: exact.timestamp,
        }
      }
    } catch {
      // Ignore and fall back to tree traversal
    }

    // Start from top epoch and traverse down, tracking found epoch
    return this.findAtEpochWithMetadata(
      at,
      new EpochIndex(0n, MAX_LEVEL),
      undefined,
    )
  }

  /**
   * Recursively find update at epoch with full metadata tracking
   *
   * @param at - Target timestamp
   * @param epoch - Current epoch to check
   * @param currentBest - Best result found so far
   * @returns EpochLookupResult if found, undefined otherwise
   */
  private async findAtEpochWithMetadata(
    at: bigint,
    epoch: EpochIndex,
    currentBest: EpochLookupResult | undefined,
  ): Promise<EpochLookupResult | undefined> {
    // Try to get chunk at this epoch
    let chunkData: { reference: Uint8Array; timestamp: bigint } | undefined
    try {
      chunkData = await this.getEpochChunkWithMetadata(at, epoch)
    } catch {
      // Chunk missing at this epoch
      if (epoch.isLeft()) {
        return currentBest
      }
      return this.findAtEpochWithMetadata(
        epoch.start - 1n,
        epoch.left(),
        currentBest,
      )
    }

    // If chunk found and valid
    if (chunkData) {
      const result: EpochLookupResult = {
        reference: chunkData.reference,
        epoch,
        timestamp: chunkData.timestamp,
      }

      // If at finest resolution, this is our answer
      if (epoch.level === 0) {
        return result
      }

      // Continue to finer resolution
      return this.findAtEpochWithMetadata(at, epoch.childAt(at), result)
    }

    // Chunk exists but timestamp invalid
    // Keep descending towards the target epoch first
    if (epoch.level > 0) {
      const down = await this.findAtEpochWithMetadata(
        at,
        epoch.childAt(at),
        currentBest,
      )
      if (down) {
        return down
      }
    }

    if (epoch.isLeft()) {
      return currentBest
    }

    // Right child - need to search left sibling branch
    return this.findAtEpochWithMetadata(
      epoch.start - 1n,
      epoch.left(),
      currentBest,
    )
  }

  /**
   * Fetch chunk for a specific epoch and return full metadata
   *
   * @param at - Target timestamp for validation
   * @param epoch - Epoch to fetch
   * @returns Object with reference and timestamp, or undefined if timestamp > at
   * @throws Error if chunk not found or not signed by the owner
   */
  private getEpochChunkWithMetadata(
    at: bigint,
    epoch: EpochIndex,
  ): Promise<EpochEntry | undefined> {
    return fetchEpochEntry(
      this.bee,
      this.topic,
      this.owner,
      epoch,
      at,
      this.encryptionKey,
    )
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

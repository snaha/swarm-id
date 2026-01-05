/**
 * Types for Epoch-Based Feeds
 */

import type { Bee, EthAddress, Topic, PrivateKey } from "@ethersphere/bee-js"
import type { EpochIndex } from "./epoch"

/**
 * Options for creating an epoch feed reader
 */
export interface EpochFeedOptions {
  /** Bee instance for chunk operations */
  bee: Bee

  /** Feed topic (32 bytes) */
  topic: Topic

  /** Feed owner address */
  owner: EthAddress
}

/**
 * Options for creating an epoch feed writer
 */
export interface EpochFeedWriterOptions extends EpochFeedOptions {
  /** Private key for signing chunks */
  signer: PrivateKey
}

/**
 * Result from an epoch feed lookup
 */
export interface EpochLookupResult {
  /** Swarm reference (32 bytes) */
  reference: Uint8Array

  /** Epoch where the update was found */
  epoch: EpochIndex

  /** Timestamp of the update */
  timestamp: bigint
}

/**
 * Interface for epoch feed finders (readers)
 *
 * Implementations: SyncEpochFinder, AsyncEpochFinder
 */
export interface EpochFinder {
  /**
   * Find the feed update valid at time `at`
   *
   * @param at - Target unix timestamp (seconds)
   * @param after - Hint of latest known update timestamp (0 if unknown)
   * @returns 32 or 64-byte Swarm reference, or undefined if no update found
   */
  findAt(at: bigint, after?: bigint): Promise<Uint8Array | undefined>
}

/**
 * Interface for epoch feed updaters (writers)
 *
 * Implementation: BasicEpochUpdater
 */
export interface EpochUpdater {
  /**
   * Update feed with a reference at given timestamp
   *
   * @param at - Unix timestamp for this update (seconds)
   * @param reference - 32 or 64-byte Swarm reference to store
   * @param postageBatchId - Batch ID for stamping
   */
  update(
    at: bigint,
    reference: Uint8Array,
    postageBatchId: string,
  ): Promise<void>

  /**
   * Get the owner address (derived from signer)
   */
  getOwner(): EthAddress

  /**
   * Get current state (for persistence/debugging)
   */
  getState(): { lastUpdate: bigint; lastEpoch: EpochIndex | undefined }

  /**
   * Restore state (from persistence)
   */
  setState(state: { lastUpdate: bigint; lastEpoch?: EpochIndex }): void

  /**
   * Reset updater state (useful for testing or reinitialization)
   */
  reset(): void
}

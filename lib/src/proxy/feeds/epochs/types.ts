/**
 * Types for Epoch-Based Feeds
 */

import type {
  Bee,
  EthAddress,
  Topic,
  PrivateKey,
  Stamper,
} from "@ethersphere/bee-js"
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

  /** Optional encryption key for encrypted feed updates */
  encryptionKey?: Uint8Array
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
 * Hints for calculating the next epoch in a stateless manner.
 * Callers should store these after each update and pass them to subsequent updates.
 */
export interface EpochUpdateHints {
  /** Previous epoch (for calculating next) */
  lastEpoch?: { start: bigint; level: number }
  /** Timestamp of last update */
  lastTimestamp?: bigint
}

/**
 * Result from an epoch feed update, including epoch info for subsequent updates.
 */
export interface EpochUpdateResult {
  /** SOC address of the uploaded chunk */
  socAddress: Uint8Array
  /** Epoch used for this update (for caller to store as hint) */
  epoch: { start: bigint; level: number }
  /** Timestamp used (for caller to store as hint) */
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
 *
 * Implements Bee-compatible stateless epoch calculation.
 * Each update uses hints from the previous update to calculate the next epoch,
 * creating a proper epoch tree that Bee's finder can traverse.
 */
export interface EpochUpdater {
  /**
   * Update feed with a reference at given timestamp
   *
   * Calculates the appropriate epoch based on hints:
   * - First update (no hints): uses root epoch (level 32, start 0)
   * - Subsequent updates: calculates next epoch using LCA-based algorithm
   *
   * @param at - Unix timestamp for this update (seconds)
   * @param reference - 32 or 64-byte Swarm reference to store
   * @param stamper - Stamper object for stamping
   * @param encryptionKey - Optional encryption key for the update
   * @param hints - Optional hints from previous update for calculating epoch
   * @returns Update result with SOC address and epoch info for next update
   */
  update(
    at: bigint,
    reference: Uint8Array,
    stamper: Stamper,
    encryptionKey?: Uint8Array,
    hints?: EpochUpdateHints,
  ): Promise<EpochUpdateResult>

  /**
   * Get the owner address (derived from signer)
   */
  getOwner(): EthAddress
}

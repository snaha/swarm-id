/**
 * Types for Sequential Feeds
 */

import type {
  Bee,
  EthAddress,
  Topic,
  PrivateKey,
  Stamper,
  BeeRequestOptions,
} from "@ethersphere/bee-js"

/**
 * Options for creating a sequential feed reader
 */
export interface SequentialFeedOptions {
  /** Bee instance for chunk operations */
  bee: Bee

  /** Feed topic (32 bytes) */
  topic: Topic

  /** Feed owner address */
  owner: EthAddress
}

/**
 * Options for creating a sequential feed writer
 */
export interface SequentialFeedWriterOptions extends SequentialFeedOptions {
  /** Private key for signing chunks */
  signer: PrivateKey
}

/**
 * Result from sequential feed lookup
 */
export interface SequentialLookupResult {
  /** Current (latest) index if found */
  current?: bigint

  /** Next index to use */
  next: bigint
}

/**
 * Interface for sequential feed finders (readers)
 *
 * Implementations: SyncSequentialFinder, AsyncSequentialFinder
 */
export interface SequentialFinder {
  /**
   * Find the latest feed update index
   *
   * @param at - Ignored for sequential feeds (for compatibility with Go API)
   * @param after - Hint of latest known index (0 if unknown)
   * @returns Lookup result with current and next index
   */
  findAt(
    at: bigint,
    after?: bigint,
    requestOptions?: BeeRequestOptions,
  ): Promise<SequentialLookupResult>
}

/**
 * Interface for sequential feed updaters (writers)
 */
export interface SequentialUpdater {
  /**
   * Update feed with payload data
   *
   * @param payload - Payload to store
   * @param stamper - Stamper object for stamping
   * @returns SOC chunk address for utilization tracking
   */
  update(
    payload: Uint8Array,
    stamper: Stamper,
    encryptionKey?: Uint8Array,
  ): Promise<Uint8Array>

  /**
   * Get the owner address (derived from signer)
   */
  getOwner(): EthAddress

  /**
   * Get current state (for persistence/debugging)
   */
  getState(): { nextIndex: bigint }

  /**
   * Restore state (from persistence)
   */
  setState(state: { nextIndex: bigint }): void

  /**
   * Reset updater state (useful for testing or reinitialization)
   */
  reset(): void
}

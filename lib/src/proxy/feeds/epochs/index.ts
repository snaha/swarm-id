/**
 * Epoch-Based Feeds
 *
 * Time-based feed indexing using a binary tree structure for efficient
 * sparse updates across long time periods.
 */

// Core exports
export { EpochIndex, lca, next, MAX_LEVEL, type Epoch } from "./epoch"

// Interface exports
export type {
  EpochFinder,
  EpochUpdater,
  EpochFeedOptions,
  EpochFeedWriterOptions,
  EpochLookupResult,
} from "./types"

// Implementation exports
export { SyncEpochFinder } from "./finder"
export { AsyncEpochFinder } from "./async-finder"
export { BasicEpochUpdater } from "./updater"

// Convenience factory functions
import { SyncEpochFinder } from "./finder"
import { AsyncEpochFinder } from "./async-finder"
import { BasicEpochUpdater } from "./updater"
import type {
  EpochFinder,
  EpochUpdater,
  EpochFeedOptions,
  EpochFeedWriterOptions,
} from "./types"

/**
 * Create a synchronous epoch feed finder (non-concurrent)
 *
 * @returns EpochFinder implementation
 */
export function createSyncEpochFinder(options: EpochFeedOptions): EpochFinder {
  return new SyncEpochFinder(options.bee, options.topic, options.owner)
}

/**
 * Create an async epoch feed finder (concurrent)
 *
 * @returns EpochFinder implementation
 */
export function createAsyncEpochFinder(options: EpochFeedOptions): EpochFinder {
  return new AsyncEpochFinder(options.bee, options.topic, options.owner)
}

/**
 * Create an epoch feed updater
 *
 * @returns EpochUpdater implementation
 */
export function createEpochUpdater(
  options: EpochFeedWriterOptions,
): EpochUpdater {
  return new BasicEpochUpdater(options.bee, options.topic, options.signer)
}

/**
 * @deprecated Use createSyncEpochFinder instead
 */
export const createEpochFinder = createSyncEpochFinder

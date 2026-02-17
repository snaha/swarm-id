/**
 * Sequential Feeds
 *
 * Sequential feed indexing for versioned updates.
 */

export type {
  SequentialFeedOptions,
  SequentialFeedWriterOptions,
  SequentialLookupResult,
  SequentialFinder,
  SequentialUpdater,
} from "./types"

export { SyncSequentialFinder } from "./finder"
export { AsyncSequentialFinder } from "./async-finder"
export { BasicSequentialUpdater } from "./updater"

import { SyncSequentialFinder } from "./finder"
import { AsyncSequentialFinder } from "./async-finder"
import { BasicSequentialUpdater } from "./updater"
import type {
  SequentialFeedOptions,
  SequentialFeedWriterOptions,
  SequentialFinder,
  SequentialUpdater,
} from "./types"

/**
 * Create a synchronous sequential feed finder
 */
export function createSyncSequentialFinder(
  options: SequentialFeedOptions,
): SequentialFinder {
  return new SyncSequentialFinder(options.bee, options.topic, options.owner)
}

/**
 * Create an async sequential feed finder
 */
export function createAsyncSequentialFinder(
  options: SequentialFeedOptions,
): SequentialFinder {
  return new AsyncSequentialFinder(options.bee, options.topic, options.owner)
}

/**
 * Create a sequential feed updater
 */
export function createSequentialUpdater(
  options: SequentialFeedWriterOptions,
): SequentialUpdater {
  return new BasicSequentialUpdater(options.bee, options.topic, options.signer)
}

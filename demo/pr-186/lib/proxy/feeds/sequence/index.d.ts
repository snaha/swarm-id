/**
 * Sequential Feeds
 *
 * Sequential feed indexing for versioned updates.
 */
export type { SequentialFeedOptions, SequentialFeedWriterOptions, SequentialLookupResult, SequentialFinder, SequentialUpdater, } from "./types";
export { SyncSequentialFinder } from "./finder";
export { AsyncSequentialFinder } from "./async-finder";
export { BasicSequentialUpdater } from "./updater";
import type { SequentialFeedOptions, SequentialFeedWriterOptions, SequentialFinder, SequentialUpdater } from "./types";
/**
 * Create a synchronous sequential feed finder
 */
export declare function createSyncSequentialFinder(options: SequentialFeedOptions): SequentialFinder;
/**
 * Create an async sequential feed finder
 */
export declare function createAsyncSequentialFinder(options: SequentialFeedOptions): SequentialFinder;
/**
 * Create a sequential feed updater
 */
export declare function createSequentialUpdater(options: SequentialFeedWriterOptions): SequentialUpdater;
//# sourceMappingURL=index.d.ts.map
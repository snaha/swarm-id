/**
 * Epoch-Based Feeds
 *
 * Time-based feed indexing using a binary tree structure for efficient
 * sparse updates across long time periods.
 */
export { EpochIndex, lca, next, MAX_LEVEL, type Epoch } from './epoch';
export type { EpochFinder, EpochUpdater, EpochFeedOptions, EpochFeedWriterOptions, EpochLookupResult, } from './types';
export { SyncEpochFinder } from './finder';
export { AsyncEpochFinder } from './async-finder';
export { BasicEpochUpdater } from './updater';
import type { EpochFinder, EpochUpdater, EpochFeedOptions, EpochFeedWriterOptions } from './types';
/**
 * Create a synchronous epoch feed finder (non-concurrent)
 *
 * @returns EpochFinder implementation
 */
export declare function createSyncEpochFinder(options: EpochFeedOptions): EpochFinder;
/**
 * Create an async epoch feed finder (concurrent)
 *
 * @returns EpochFinder implementation
 */
export declare function createAsyncEpochFinder(options: EpochFeedOptions): EpochFinder;
/**
 * Create an epoch feed updater
 *
 * @returns EpochUpdater implementation
 */
export declare function createEpochUpdater(options: EpochFeedWriterOptions): EpochUpdater;
/**
 * @deprecated Use createSyncEpochFinder instead
 */
export declare const createEpochFinder: typeof createSyncEpochFinder;
//# sourceMappingURL=index.d.ts.map
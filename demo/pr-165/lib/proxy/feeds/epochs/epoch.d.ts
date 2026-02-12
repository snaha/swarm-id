/**
 * Epoch-based Feed Indexing
 *
 * Implements time-based indexing using a binary tree structure where each epoch
 * represents a time range with start time and level (0-32).
 *
 * Based on the Swarm Book of Feeds and Bee's epochs implementation.
 */
/** Maximum epoch level (2^32 seconds ≈ 136 years) */
export declare const MAX_LEVEL = 32;
/**
 * Epoch interface - represents a time slot in the epoch tree
 */
export interface Epoch {
    start: bigint;
    level: number;
}
/**
 * EpochIndex class - implements epoch-based feed indexing
 *
 * Each epoch represents a time range:
 * - start: beginning timestamp of the epoch
 * - level: determines the epoch's time span (2^level seconds)
 *
 * Epochs form a binary tree structure for efficient sparse updates.
 */
export declare class EpochIndex implements Epoch {
    readonly start: bigint;
    readonly level: number;
    constructor(start: bigint, level: number);
    /**
     * Marshal epoch to binary format for hashing
     * Returns Keccak256 hash of start (8 bytes big-endian) + level (1 byte)
     */
    marshalBinary(): Promise<Uint8Array>;
    /**
     * Calculate the next epoch for a new update
     * @param last - Timestamp of last update
     * @param at - Timestamp of new update
     */
    next(last: bigint, at: bigint): EpochIndex;
    /**
     * Calculate epoch length in seconds (2^level)
     */
    length(): bigint;
    /**
     * Get parent epoch
     * UNSAFE: Do not call on top-level epoch (level 32)
     */
    parent(): EpochIndex;
    /**
     * Get left sibling epoch
     * UNSAFE: Do not call on left sibling (when start is aligned to 2*length)
     */
    left(): EpochIndex;
    /**
     * Get child epoch containing timestamp `at`
     * UNSAFE: Do not call with `at` outside this epoch's range
     */
    childAt(at: bigint): EpochIndex;
    /**
     * Check if this epoch is a left child of its parent
     */
    isLeft(): boolean;
    /**
     * String representation: "start/level"
     */
    toString(): string;
}
/**
 * Calculate Lowest Common Ancestor epoch for two timestamps
 *
 * The LCA is the smallest epoch that contains both `at` and `after`.
 * This is used to find the optimal starting point for feed lookups.
 *
 * @param at - Target timestamp
 * @param after - Reference timestamp (0 if no previous update)
 * @returns LCA epoch
 */
export declare function lca(at: bigint, after: bigint): EpochIndex;
/**
 * Helper function to get next epoch for update, handling null previous epoch
 * @param prevEpoch - Previous epoch (null if first update)
 * @param last - Timestamp of last update
 * @param at - Timestamp of new update
 */
export declare function next(prevEpoch: EpochIndex | undefined, last: bigint, at: bigint): EpochIndex;
//# sourceMappingURL=epoch.d.ts.map
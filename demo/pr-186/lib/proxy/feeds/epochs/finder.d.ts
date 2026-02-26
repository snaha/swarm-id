/**
 * Synchronous Epoch Feed Finder
 *
 * Recursive implementation for finding feed updates at specific timestamps
 * using epoch-based indexing.
 */
import type { Bee } from "@ethersphere/bee-js";
import { EthAddress, Topic } from "@ethersphere/bee-js";
import type { EpochFinder } from "./types";
/**
 * Synchronous recursive finder for epoch-based feeds
 *
 * Traverses the epoch tree recursively to find the feed update
 * valid at a specific timestamp.
 *
 * Implements the EpochFinder interface.
 */
export declare class SyncEpochFinder implements EpochFinder {
    private readonly bee;
    private readonly topic;
    private readonly owner;
    constructor(bee: Bee, topic: Topic, owner: EthAddress);
    /**
     * Find the feed update valid at time `at`
     * @param at - Target unix timestamp (seconds)
     * @param after - Hint of latest known update timestamp (0 if unknown)
     * @returns 32-byte Swarm reference, or undefined if no update found
     */
    findAt(at: bigint, after?: bigint): Promise<Uint8Array | undefined>;
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
    private common;
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
    private atEpoch;
    /**
     * Fetch chunk for a specific epoch
     *
     * Calculates the chunk address from topic, epoch, and owner,
     * then downloads it from the Bee node.
     *
     * @param at - Target timestamp for validation
     * @param epoch - Epoch to fetch
     * @returns Chunk reference (32 or 64 bytes), or undefined if timestamp invalid
     * @throws Error if chunk not found or network error
     */
    private getEpochChunk;
    private findPreviousLeaf;
}
//# sourceMappingURL=finder.d.ts.map
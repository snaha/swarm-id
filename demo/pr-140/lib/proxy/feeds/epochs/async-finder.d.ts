/**
 * Async Epoch Feed Finder (Concurrent)
 *
 * Concurrent implementation for finding feed updates at specific timestamps
 * using epoch-based indexing with parallel chunk fetching.
 */
import type { Bee } from "@ethersphere/bee-js";
import { EthAddress, Topic } from "@ethersphere/bee-js";
import type { EpochFinder } from "./types";
/**
 * Async concurrent finder for epoch-based feeds
 *
 * Launches parallel chunk fetches along the epoch tree path
 * to find the feed update valid at a specific timestamp.
 *
 * Implements the EpochFinder interface.
 */
export declare class AsyncEpochFinder implements EpochFinder {
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
    findAt(at: bigint, _after?: bigint): Promise<Uint8Array | undefined>;
    /**
     * Recursively find update at epoch, with parallel fetching
     *
     * @param at - Target timestamp
     * @param epoch - Current epoch to check
     * @param currentBest - Best result found so far
     * @returns Reference if found, undefined otherwise
     */
    private findAtEpoch;
    /**
     * Attempt to fetch chunk for an epoch
     *
     * @param at - Target timestamp (for validation)
     * @param epoch - Epoch to fetch
     * @returns Chunk data if found and valid, undefined otherwise
     */
    private getEpoch;
    /**
     * Fetch chunk for a specific epoch
     *
     * @param at - Target timestamp for validation
     * @param epoch - Epoch to fetch
     * @returns Chunk payload
     * @throws Error if chunk not found
     */
    private getEpochChunk;
}
//# sourceMappingURL=async-finder.d.ts.map
/**
 * Synchronous Sequential Feed Finder
 *
 * Linear scan implementation for finding the latest update index.
 * Mirrors the Go sequential finder behavior.
 */
import type { Bee, EthAddress, Topic, BeeRequestOptions } from "@ethersphere/bee-js";
import type { SequentialFinder, SequentialLookupResult } from "./types";
export declare class SyncSequentialFinder implements SequentialFinder {
    private readonly bee;
    private readonly topic;
    private readonly owner;
    constructor(bee: Bee, topic: Topic, owner: EthAddress);
    findAt(_at: bigint, _after?: bigint, requestOptions?: BeeRequestOptions): Promise<SequentialLookupResult>;
    private indexExists;
}
//# sourceMappingURL=finder.d.ts.map
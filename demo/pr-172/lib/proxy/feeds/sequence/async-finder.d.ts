/**
 * Async Sequential Feed Finder
 *
 * Currently delegates to the sync finder to match Go behavior
 * while keeping an async interface.
 */
import type { Bee, EthAddress, Topic, BeeRequestOptions } from "@ethersphere/bee-js";
import type { SequentialFinder, SequentialLookupResult } from "./types";
export declare class AsyncSequentialFinder implements SequentialFinder {
    private readonly syncFinder;
    constructor(bee: Bee, topic: Topic, owner: EthAddress);
    findAt(at: bigint, after?: bigint, requestOptions?: BeeRequestOptions): Promise<SequentialLookupResult>;
}
//# sourceMappingURL=async-finder.d.ts.map
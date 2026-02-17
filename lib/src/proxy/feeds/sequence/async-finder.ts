/**
 * Async Sequential Feed Finder
 *
 * Currently delegates to the sync finder to match Go behavior
 * while keeping an async interface.
 */

import type {
  Bee,
  EthAddress,
  Topic,
  BeeRequestOptions,
} from "@ethersphere/bee-js"
import type { SequentialFinder, SequentialLookupResult } from "./types"
import { SyncSequentialFinder } from "./finder"

export class AsyncSequentialFinder implements SequentialFinder {
  private readonly syncFinder: SyncSequentialFinder

  constructor(bee: Bee, topic: Topic, owner: EthAddress) {
    this.syncFinder = new SyncSequentialFinder(bee, topic, owner)
  }

  async findAt(
    at: bigint,
    after: bigint = 0n,
    requestOptions?: BeeRequestOptions,
  ): Promise<SequentialLookupResult> {
    return this.syncFinder.findAt(at, after, requestOptions)
  }
}

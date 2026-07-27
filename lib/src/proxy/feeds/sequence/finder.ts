// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synchronous Sequential Feed Finder
 *
 * Linear scan implementation for finding the latest update index.
 * Mirrors the Go sequential finder behavior.
 */

import { Binary } from "cafe-utility"
import type {
  Bee,
  EthAddress,
  Topic,
  BeeRequestOptions,
} from "@ethersphere/bee-js"
import type { SequentialFinder, SequentialLookupResult } from "./types"
import { socAddress } from "../../../utils/soc-address"

function makeSequentialIdentifier(topic: Topic, index: bigint): Uint8Array {
  const indexBytes = Binary.numberToUint64(index, "BE")
  return Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), indexBytes))
}

export class SyncSequentialFinder implements SequentialFinder {
  constructor(
    private readonly bee: Bee,
    private readonly topic: Topic,
    private readonly owner: EthAddress,
  ) {}

  async findAt(
    _at: bigint,
    _after: bigint = 0n,
    requestOptions?: BeeRequestOptions,
  ): Promise<SequentialLookupResult> {
    for (let index = 0n; ; index++) {
      const exists = await this.indexExists(index, requestOptions)
      if (!exists) {
        return {
          current: index > 0n ? index - 1n : undefined,
          next: index,
        }
      }
    }
  }

  private async indexExists(
    index: bigint,
    requestOptions?: BeeRequestOptions,
  ): Promise<boolean> {
    const identifier = makeSequentialIdentifier(this.topic, index)
    const address = socAddress(identifier, this.owner)

    // Bee's /chunks endpoint returns 500 ("read chunk failed") for a genuinely
    // absent chunk — indistinguishable by status from a transient 500 — so a
    // single failed read can't tell "free slot" from "blip on an existing entry".
    // Retry once; conclude the slot is free only if BOTH reads fail. This narrows
    // the window where a transient failure lets an append clobber a peer's roster
    // entry. We can't rethrow on failure (absence has no distinct signal here), so
    // the scan must still terminate on a persistent miss.
    // ponytail: single retry — matches readPartitionSoc; add backoff/more attempts
    // only if real gateways prove one insufficient.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.bee.downloadChunk(
          Binary.uint8ArrayToHex(address),
          undefined,
          requestOptions,
        )
        return true
      } catch {
        if (attempt === 0) continue
        return false
      }
    }
    return false
  }
}

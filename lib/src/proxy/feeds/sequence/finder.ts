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
import { Reference } from "@ethersphere/bee-js"
import type { SequentialFinder, SequentialLookupResult } from "./types"

function makeSequentialIdentifier(topic: Topic, index: bigint): Uint8Array {
  const indexBytes = Binary.numberToUint64(index, "BE")
  return Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), indexBytes))
}

function makeSequentialAddress(
  identifier: Uint8Array,
  owner: EthAddress,
): Reference {
  return new Reference(
    Binary.keccak256(Binary.concatBytes(identifier, owner.toUint8Array())),
  )
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
    const address = makeSequentialAddress(identifier, this.owner)

    try {
      await this.bee.downloadChunk(
        Binary.uint8ArrayToHex(address.toUint8Array()),
        undefined,
        requestOptions,
      )
      return true
    } catch {
      return false
    }
  }
}

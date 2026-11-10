// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Experimental (#306): a `Bee` whose chunk I/O goes through weeb-3, a Swarm
 * node running in the browser (https://github.com/lat-murmeldjur/weeb-3),
 * instead of a Bee's HTTP API.
 *
 * Only what weeb-3 can stand in for is rerouted: stamped chunk and SOC pushes,
 * chunk reads, the connectivity check, and tags (reported unsupported). Every
 * other call keeps going to `WEEB3_BEE_URL`, which resolves nowhere, so a gap
 * fails loudly instead of quietly reaching a real node.
 */

import { Bee } from "@ethersphere/bee-js"
import type { EnvelopeWithBatchId } from "@ethersphere/bee-js"
import { convertEnvelopeToMarshaledStamp } from "@ethersphere/core-sdk"
import { Binary } from "cafe-utility"
import { calculateChunkAddress } from "../chunk"

/** The part of weeb-3's `Weeb3No103` this adapter needs. */
export interface Weeb3Node {
  postPushChunk(
    data: Uint8Array,
    soc: boolean,
    chunkAddress: Uint8Array,
    stamp: Uint8Array,
  ): Promise<string>
  retrieveChunk(address: string): Promise<Uint8Array>
  connectionCount(): Promise<number>
}

/** `.invalid` never resolves (RFC 2606). */
export const WEEB3_BEE_URL = "http://weeb3.invalid"

/** What `postPushChunk` resolves with when the push was acknowledged. */
const PUSH_SUCCESS = "Upload result: success"
const NOT_FOUND = 404

type Push = (
  data: Uint8Array,
  soc: boolean,
  address: Uint8Array,
  stamp: EnvelopeWithBatchId,
) => Promise<void>

const pushers = new WeakMap<Bee, Push>()

/** The weeb-3 push behind `bee`, for the SOC upload that bypasses bee-js. */
export function weeb3Push(bee: Bee): Push | undefined {
  return pushers.get(bee)
}

export function createWeeb3Bee(node: Promise<Weeb3Node>): Bee {
  const bee = new Bee(WEEB3_BEE_URL)

  const push: Push = async (data, soc, address, stamp) => {
    const result = await (
      await node
    ).postPushChunk(
      data,
      soc,
      address,
      convertEnvelopeToMarshaledStamp(stamp).toUint8Array(),
    )
    if (result !== PUSH_SUCCESS) {
      throw new Error(`weeb-3 push failed: ${result}`)
    }
  }
  pushers.set(bee, push)

  Object.assign(bee.chunk, {
    async upload(stamp: EnvelopeWithBatchId, data: Uint8Array) {
      const address = calculateChunkAddress(data)
      await push(data, false, address.toUint8Array(), stamp)
      return { reference: address }
    },
    async download(reference: Uint8Array | string | { toHex(): string }) {
      const hex =
        typeof reference === "string"
          ? reference
          : reference instanceof Uint8Array
            ? Binary.uint8ArrayToHex(reference)
            : reference.toHex()
      const data = await (await node).retrieveChunk(hex)
      if (data.length === 0) {
        // Shaped like `BeeResponseError`, so `isNotFoundError` reads a miss.
        throw Object.assign(new Error(`weeb-3: chunk ${hex} not found`), {
          status: NOT_FOUND,
        })
      }
      // ponytail: weeb-3 strips a SOC's identifier and signature on retrieve,
      // so a SOC read (feeds, the device roster) cannot be verified. Said here
      // rather than left to fail somewhere downstream; needs a raw read in weeb-3.
      if (
        Binary.uint8ArrayToHex(calculateChunkAddress(data).toUint8Array()) !==
        hex
      ) {
        throw new Error(
          `weeb-3: ${hex} is a SOC, which weeb-3 returns without its signature`,
        )
      }
      return data
    },
  })
  Object.assign(bee.tag, {
    async create() {
      throw Object.assign(new Error("weeb-3 has no tags"), {
        status: NOT_FOUND,
      })
    },
  })
  Object.assign(bee.connectivity, {
    async isConnected() {
      return (await (await node).connectionCount()) > 0
    },
  })

  return bee
}

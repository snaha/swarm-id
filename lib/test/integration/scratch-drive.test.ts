// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A scratch drive's lane is a ring (#862): once full, the next stamp in a
 * bucket lands on that lane's oldest slot instead of being refused. This is
 * the part only a real Bee can answer — that it accepts a stamp re-using an
 * index the batch already spent, carrying a newer timestamp — and that the
 * newest write is the one served.
 *
 * Whether the overwritten chunk is actually evicted cannot be seen here: the
 * uploading node keeps its own copy. `test/live` is where that is checked.
 */
import { describe, it, expect, inject } from "vitest"
import {
  BatchId,
  EthAddress,
  Identifier,
  PrivateKey,
} from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { uploadSOC } from "../../src/proxy/upload"
import { downloadSOC } from "../../src/proxy/download-data"
import type { UtilizationStoreDB } from "../../src/storage/utilization-store"
import {
  PARTITION_COUNT,
  UtilizationAwareStamper,
  partitionCapacity,
} from "../../src/utils/batch-utilization"
import { QUEEN_KEY, TEST_STAMP_DEPTH, createQueenBee } from "./cluster"

const ID_BYTES = 32
const SOC_PAYLOAD_SIZE = 32
const BUCKET_BYTE_MASK = 0xff
const BITS_PER_BYTE = 8
/** One more write than the lane holds is enough to wrap it. */
const WRAP_TEST_TIMEOUT_MS = 120_000

const emptyCache = {
  getAllChunks: async () => [],
  putChunk: async () => undefined,
} as unknown as UtilizationStoreDB

/** An identifier whose SOC address (keccak(id ‖ owner)) falls in `bucket`. */
function mineIdentifierInBucket(owner: EthAddress, bucket: number): Identifier {
  const ownerBytes = owner.toUint8Array()
  const preimage = new Uint8Array(ID_BYTES + ownerBytes.length)
  preimage.set(ownerBytes, ID_BYTES)
  const high = bucket >> BITS_PER_BYTE
  const low = bucket & BUCKET_BYTE_MASK
  for (;;) {
    crypto.getRandomValues(preimage.subarray(0, ID_BYTES))
    const address = Binary.keccak256(preimage)
    if (address[0] === high && address[1] === low) {
      return new Identifier(preimage.slice(0, ID_BYTES))
    }
  }
}

describe("scratch drive (live Bee)", () => {
  it(
    "accepts writes past a full lane, and serves the newest",
    async () => {
      const bee = createQueenBee()
      const batchId = new BatchId(inject("clusterBatchId"))
      const stamper = await UtilizationAwareStamper.create(
        QUEEN_KEY,
        batchId,
        TEST_STAMP_DEPTH,
        emptyCache,
        new EthAddress("00".repeat(20)),
        new Uint8Array(ID_BYTES),
        undefined,
        { scratch: true },
      )
      // The second lane: a fresh counter, so the run does not depend on what
      // other suites stamped into this shared batch.
      stamper.bindPartition({
        partition: 1,
        partitionCount: PARTITION_COUNT,
        localCounter: new Uint32Array(stamper.getState().length),
      })
      const target = { mode: "stamper" as const, bee, stamper }

      const signer = new PrivateKey(
        crypto.getRandomValues(new Uint8Array(ID_BYTES)),
      )
      const owner = signer.publicKey().address()
      const bucket = crypto.getRandomValues(new Uint16Array(1))[0]
      const writes = partitionCapacity(TEST_STAMP_DEPTH, PARTITION_COUNT) + 1

      let newest: { identifier: Identifier; data: Uint8Array } | undefined
      for (let i = 0; i < writes; i++) {
        const identifier = mineIdentifierInBucket(owner, bucket)
        const data = crypto.getRandomValues(new Uint8Array(SOC_PAYLOAD_SIZE))
        await uploadSOC(target, signer, identifier, data)
        newest = { identifier, data }
      }

      const soc = await downloadSOC(bee, owner, newest!.identifier)
      expect(soc.payload).toEqual(newest!.data)
    },
    WRAP_TEST_TIMEOUT_MS,
  )
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A scratch drive's lane wraps onto its oldest slot (#862, #881). The cluster
 * test proves Bee accepts the re-used stamp index and serves the newest
 * chunk; it cannot prove the oldest is gone, because the node that uploaded
 * it keeps its own copy. On a real network the storers can say: every chunk
 * of one bucket shares the bucket's leading bits, so one neighbourhood holds
 * them all, sees the newer stamp arrive on the index the oldest used, and
 * evicts it (#884).
 *
 * So: fill one bucket's lane and one more through `BEE_URL`, then ask
 * `READ_BEE_URL` — a node or gateway that never held these chunks — for the
 * first one and expect it missing, with the newest still served as the control
 * that the reader does see this batch's writes at all.
 *
 * Opt-in, like the rest of this suite; skips without `READ_BEE_URL`. Any batch
 * will do: Bee takes the re-used index on an immutable batch too, and storers
 * replace a same-index chunk with a newer one regardless of batch type.
 */
import { describe, it, expect } from "vitest"
import {
  Bee,
  EthAddress,
  type Identifier,
  PrivateKey,
} from "@ethersphere/bee-js"
import { uploadSOC } from "../../src/proxy/upload"
import { downloadSOC } from "../../src/proxy/download-data"
import {
  PARTITION_COUNT,
  UtilizationAwareStamper,
  partitionCapacity,
} from "../../src/utils/batch-utilization"
import { isNotFoundError } from "../../src/utils/bee-error"
import { mineIdentifierInBucket } from "../soc-bucket"
import { createContext, delay, liveEnv, makeInMemoryCache } from "./env"

const ID_BYTES = 32
const SOC_PAYLOAD_SIZE = 32
/** Gateway-sized: the lane's worth of SOC uploads, and the reads behind them. */
const EVICTION_TEST_TIMEOUT_MS = 600_000
/** How long the reader is given to stop serving the evicted chunk, and how
 *  often it is asked: eviction follows the wrapped write's pushsync, not the
 *  upload response. */
const EVICTION_POLL_TRIES = 12
const EVICTION_POLL_DELAY_MS = 10_000

/** Bypasses the reader's cache: once a read has cached the chunk, the reader
 *  would keep serving its own copy and hide an eviction that lands later. */
const UNCACHED = { headers: { "swarm-cache": "false" } }

type ReadResult =
  | { served: Uint8Array }
  | { missing: true }
  | { inconclusive: unknown }

/** Only a 404 says the node has no such chunk; a 500 or a dropped connection
 *  says nothing about eviction either way. */
async function readChunk(
  bee: Bee,
  owner: EthAddress,
  identifier: Identifier,
): Promise<ReadResult> {
  try {
    return {
      served: (await downloadSOC(bee, owner, identifier, UNCACHED)).payload,
    }
  } catch (error) {
    return isNotFoundError(error) ? { missing: true } : { inconclusive: error }
  }
}

describe.skipIf(!liveEnv.configured || !liveEnv.readBeeUrl)(
  "live — scratch drive: the overwritten chunk is evicted from the network",
  () => {
    it(
      "fills a lane and one more through one node; another node no longer serves the oldest",
      async () => {
        const ctx = createContext()
        const reader = new Bee(liveEnv.readBeeUrl!)
        const stamper = await UtilizationAwareStamper.create(
          ctx.signerKey.toHex(),
          ctx.batchID,
          ctx.depth,
          makeInMemoryCache(),
          new EthAddress("00".repeat(20)),
          new Uint8Array(ID_BYTES),
          undefined,
          { scratch: true },
        )
        // A fresh counter on the second lane: the scenario is the wrap, not
        // whatever earlier runs left in the batch's indices.
        stamper.bindPartition({
          partition: 1,
          partitionCount: PARTITION_COUNT,
          localCounter: new Uint32Array(stamper.getState().length),
        })
        const target = { mode: "stamper" as const, bee: ctx.bee, stamper }

        const signer = new PrivateKey(
          crypto.getRandomValues(new Uint8Array(ID_BYTES)),
        )
        const owner = signer.publicKey().address()
        const bucket = crypto.getRandomValues(new Uint16Array(1))[0]
        const writes = partitionCapacity(ctx.depth, PARTITION_COUNT) + 1
        console.log(
          `bucket ${bucket}: ${writes} writes through ${liveEnv.beeUrl}, read back from ${liveEnv.readBeeUrl}`,
        )

        const written: { identifier: Identifier; data: Uint8Array }[] = []
        for (let i = 0; i < writes; i++) {
          const identifier = mineIdentifierInBucket(owner, bucket)
          const data = crypto.getRandomValues(new Uint8Array(SOC_PAYLOAD_SIZE))
          await uploadSOC(target, signer, identifier, data)
          written.push({ identifier, data })
        }
        const oldest = written[0]
        const newest = written[written.length - 1]

        // The control: the reader sees this batch's writes at all.
        let control: ReadResult = { missing: true }
        for (
          let i = 0;
          i < EVICTION_POLL_TRIES && !("served" in control);
          i++
        ) {
          if (i > 0) await delay(EVICTION_POLL_DELAY_MS)
          control = await readChunk(reader, owner, newest.identifier)
        }
        expect(
          "served" in control && control.served,
          "the reader never served the newest chunk",
        ).toEqual(newest.data)

        // The claim: the chunk the wrap overwrote is no longer served.
        let claim: ReadResult = { served: oldest.data }
        for (let i = 0; i < EVICTION_POLL_TRIES && !("missing" in claim); i++) {
          if (i > 0) await delay(EVICTION_POLL_DELAY_MS)
          claim = await readChunk(reader, owner, oldest.identifier)
        }
        expect(
          "missing" in claim,
          "inconclusive" in claim
            ? `inconclusive: the reader's last read failed without a 404 (${String(claim.inconclusive)})`
            : `the reader still serves the overwritten chunk after ${EVICTION_POLL_TRIES} reads`,
        ).toBe(true)
      },
      EVICTION_TEST_TIMEOUT_MS,
    )
  },
)

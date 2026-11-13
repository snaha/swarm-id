// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A SOC written again at its address reads back as the newest write, through
 * the node that uploaded it.
 *
 * The partition lease stands on this: its lock, the release sentinel that
 * frees a lane at once, and the beacons a holder re-publishes all rewrite one
 * address. A deferred upload does not give it: the node keeps the first chunk
 * it stored there and goes on serving that one. Bee's `/soc` handler takes the
 * upload as deferred unless told otherwise, from 2.8.1 on.
 */

import { describe, it, expect, inject } from "vitest"
import { Identifier, PrivateKey } from "@ethersphere/bee-js"
import { uploadSOC } from "../../src/proxy/upload"
import { downloadSOC } from "../../src/proxy/download-data"
import { createQueenBee, createQueenStamper } from "./cluster"

const KEY_BYTES = 32
const WRITES = ["first", "second", "third"]
/** A direct upload is readable once its request returns; this is slack. */
const READ_BACK_TIMEOUT_MS = 15_000
const READ_BACK_INTERVAL_MS = 500

describe("a SOC rewritten at its address (live Bee)", () => {
  it("reads back as the latest write, every time", async () => {
    const bee = createQueenBee()
    const batchId = inject("clusterBatchId")
    const signer = new PrivateKey(
      crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
    )
    const owner = signer.publicKey().address()
    const identifier = new Identifier(
      crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
    )
    const readBack = async () =>
      new TextDecoder().decode(
        (await downloadSOC(bee, owner, identifier)).payload,
      )

    for (const text of WRITES) {
      // A blank stamper per write stamps the same slot of the same bucket
      // with a newer timestamp, as the lease's reserved slot does for its lock.
      const target = {
        mode: "stamper" as const,
        bee,
        stamper: createQueenStamper(batchId),
      }
      await uploadSOC(
        target,
        signer,
        identifier,
        new TextEncoder().encode(text),
      )
      await expect
        .poll(readBack, {
          timeout: READ_BACK_TIMEOUT_MS,
          interval: READ_BACK_INTERVAL_MS,
        })
        .toBe(text)
    }
  })
})

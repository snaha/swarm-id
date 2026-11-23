// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A SOC written again at its address reads back as the newest write, through
 * the node that uploaded it and through every other node of the cluster.
 *
 * The partition lease stands on this: its lock, the release sentinel that
 * frees a lane at once, and the beacons a holder re-publishes all rewrite one
 * address, and another device reads them through its own node. A deferred
 * upload does not give it: the node keeps the first chunk it stored there and
 * goes on serving that one. From 2.8.1 Bee's `/soc` handler takes a tagged
 * upload as deferred unless `Swarm-Deferred-Upload` says otherwise, and
 * `uploadSOC` tags every stamped upload.
 */

import { describe, it, expect, inject } from "vitest"
import { Bee, Identifier, PrivateKey } from "@ethersphere/bee-js"
import { uploadSOC } from "../../src/proxy/upload"
import { downloadSOC } from "../../src/proxy/download-data"
import { WORKER_URLS, createQueenBee, createQueenStamper } from "./cluster"

const KEY_BYTES = 32
const WRITES = ["first", "second", "third"]
/**
 * #1016 measured every node of the cluster serving a direct rewrite within
 * two seconds.
 */
const OTHER_NODE_TIMEOUT_MS = 3_000
const OTHER_NODE_INTERVAL_MS = 250

describe("a SOC rewritten at its address (live Bee)", () => {
  it("reads back as the latest write, on every node, every time", async () => {
    const bee = createQueenBee()
    const workers = WORKER_URLS.map((url) => new Bee(url))
    const batchId = inject("clusterBatchId")
    const signer = new PrivateKey(
      crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
    )
    const owner = signer.publicKey().address()
    const identifier = new Identifier(
      crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
    )
    const readBack = async (through: Bee) =>
      new TextDecoder().decode(
        (await downloadSOC(through, owner, identifier)).payload,
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
      // A direct upload is readable on its own node once the request returns.
      expect(await readBack(bee)).toBe(text)
      for (const worker of workers) {
        await expect
          .poll(() => readBack(worker), {
            timeout: OTHER_NODE_TIMEOUT_MS,
            interval: OTHER_NODE_INTERVAL_MS,
          })
          .toBe(text)
      }
    }
  })
})

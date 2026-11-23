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
const FIRST = "first"
const REWRITES = ["second", "third"]
/**
 * How long every node may take to serve the first write at a fresh address.
 * Not a rewrite, and not what this test bounds: on the local cluster the
 * uploading node's first read of the address took up to 15 s, while the
 * other nodes served it within 50 ms.
 */
const FIRST_READ_TIMEOUT_MS = 30_000
/**
 * How long after a rewrite's upload returns every node, the uploading one
 * included, may still serve the previous write. Not zero: CI saw the
 * uploading node serve the previous write right after the request returned.
 * On the local cluster every node served each rewrite within 0.6 s, over 20
 * runs; #1016 measured within two seconds.
 */
const REWRITE_READ_TIMEOUT_MS = 3_000
const READ_BACK_INTERVAL_MS = 250

describe("a SOC rewritten at its address (live Bee)", () => {
  it("reads back as the latest write, on every node, every time", async () => {
    const bee = createQueenBee()
    const nodes = [
      { label: "queen", bee },
      ...WORKER_URLS.map((url) => ({ label: url, bee: new Bee(url) })),
    ]
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

    /** Write `text` and wait for every node to serve it, within `bound`. */
    const writeAndReadBack = async (text: string, bound: number) => {
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
      const returned = Date.now()
      // Every node at once, each timed from the upload's return, so one slow
      // node does not use up another's bound.
      await Promise.all(
        nodes.map(async (node) => {
          await expect
            .poll(() => readBack(node.bee), {
              timeout: bound,
              interval: READ_BACK_INTERVAL_MS,
              message: `${node.label} did not serve "${text}"`,
            })
            .toBe(text)
          const took = Date.now() - returned
          console.log(
            `[soc-rewrite] ${node.label} served "${text}" ${took} ms after the upload returned`,
          )
          // The poll does not interrupt a read in flight, so a read that hangs
          // past the bound and then answers would still pass it.
          expect(took, `${node.label} took ${took} ms`).toBeLessThanOrEqual(
            bound,
          )
        }),
      )
    }

    await writeAndReadBack(FIRST, FIRST_READ_TIMEOUT_MS)
    for (const text of REWRITES) {
      await writeAndReadBack(text, REWRITE_READ_TIMEOUT_MS)
    }
  })
})

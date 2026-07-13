// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for plain uploads large enough to need 128-ref
 * intermediate chunks (>512 KiB), read back through Bee's native /bytes
 * API. This is the interop proof that our plain Merkle layout matches what
 * a stock node builds and can traverse (#417): with the old 64-ref fanout
 * Bee could not join these trees.
 */

import { describe, it, expect, beforeAll, inject } from "vitest"
import type { Bee } from "@ethersphere/bee-js"
import { uploadData, type UploadTarget } from "../../src/proxy/upload"
import { isClusterReachable, createClusterContext } from "./cluster"

const clusterReachable = await isClusterReachable()

const MAX_CHUNK = 4096
const PLAIN_FANOUT = 128

/**
 * Payload whose 4096-byte chunks are all DISTINCT (the `i >> 12` term shifts
 * each chunk's byte pattern). A plain `i % 256` pattern repeats every 256
 * bytes, making every full chunk identical — 129 copies of one address all
 * stamp into the same postage bucket and overflow its 2^(depth-16) slots at
 * the test stamp's depth 20.
 */
function distinctChunkPayload(size: number): Uint8Array {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) data[i] = (i * 3 + (i >> 12)) & 0xff
  return data
}

// 129 full chunks exercises the carrier-chunk promotion (a lone trailing
// leaf is promoted, not wrapped); 130 adds a two-ref root over a full
// 128-ref intermediate.
const SIZES = [(PLAIN_FANOUT + 1) * MAX_CHUNK, (PLAIN_FANOUT + 2) * MAX_CHUNK]

describe.skipIf(!clusterReachable)(
  "Large plain upload read back via Bee /bytes",
  () => {
    let bee: Bee
    let target: UploadTarget

    beforeAll(() => {
      ;({ bee, target } = createClusterContext(inject("clusterBatchId")))
    })

    // ~131 sequential single-chunk uploads per case; give slow CI headroom
    // over the suite's default 60s.
    const LARGE_UPLOAD_TIMEOUT_MS = 120_000

    for (const size of SIZES) {
      it(
        `Bee serves a ${size}-byte plain upload via /bytes`,
        { timeout: LARGE_UPLOAD_TIMEOUT_MS },
        async () => {
          const data = distinctChunkPayload(size)
          const { reference } = await uploadData(target, data)
          const downloaded = (await bee.downloadData(reference)).toUint8Array()
          expect(downloaded.length).toBe(size)
          expect(downloaded).toEqual(data)
        },
      )
    }
  },
)

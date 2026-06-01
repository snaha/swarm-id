// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cluster integration test for data round-trips at chunk-boundary sizes.
 *
 * Lives in a separate file from round-trip.cluster.test.ts to prove the
 * postage stamp acquired in global setup is shared across files: this file
 * does NOT buy its own stamp — it reuses inject("clusterBatchId").
 */

import { describe, it, expect, beforeAll, inject } from "vitest"
import type { Bee } from "@ethersphere/bee-js"
import { uploadData, type UploadTarget } from "../../src/proxy/upload"
import { downloadDataWithChunkAPI } from "../../src/proxy/download-data"
import { isClusterReachable, createClusterContext } from "./cluster"

const clusterReachable = await isClusterReachable()

function sequentialPayload(size: number): Uint8Array {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) data[i] = i % 256
  return data
}

// Sizes around the 4096-byte chunk boundary, where the single-chunk vs merkle
// tree paths diverge (the boundary that the plain-merkle-span fix corrected).
const MAX_CHUNK = 4096
const SIZES = [1, MAX_CHUNK - 1, MAX_CHUNK, MAX_CHUNK + 1, MAX_CHUNK * 2]

describe.skipIf(!clusterReachable)(
  "Data round-trip at chunk boundaries",
  () => {
    let bee: Bee
    let target: UploadTarget

    beforeAll(() => {
      ;({ bee, target } = createClusterContext(inject("clusterBatchId")))
    })

    for (const size of SIZES) {
      it(`round-trips ${size}-byte payload`, async () => {
        const data = sequentialPayload(size)
        const { reference } = await uploadData(target, data)
        const downloaded = await downloadDataWithChunkAPI(bee, reference)
        expect(downloaded.length).toBe(size)
        expect(downloaded).toEqual(data)
      })
    }
  },
)

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Erasure-coded uploads against a live Bee (#307): the tree the library builds
 * at a redundancy level is the one Bee builds, so the two agree on a plain
 * upload's reference, and each reads back what the other wrote.
 */

import { describe, it, expect, beforeAll, inject } from "vitest"
import type { Bee } from "@ethersphere/bee-js"
import { getMaxShards } from "@ethersphere/core-sdk"
import { uploadData, type UploadTarget } from "../../src/proxy/upload"
import { downloadDataWithChunkAPI } from "../../src/proxy/download-data"
import { CHUNK_SIZE } from "../../src/proxy/chunking"
import type { RedundancyLevel } from "../../src/types"
import { createClusterContext } from "./cluster"

const LEVELS: RedundancyLevel[] = [1, 2, 3, 4]
/** One leaf too many for a batch: past the batch's carrier leaf (core-sdk#9, #10) */
const loneLastLeaf = (level: RedundancyLevel, encrypted: boolean) =>
  getMaxShards(level, encrypted) * CHUNK_SIZE + 1
/**
 * One batch with parity: enough to cover the stream path. This file shares
 * the cluster with the other suites, whose direct uploads wait on push-sync,
 * so its own uploads are kept no larger than the tree they test needs.
 */
const ONE_BATCH = 10 * CHUNK_SIZE
const UPLOAD_TIMEOUT_MS = 120_000
/**
 * Deferred, as bee-js's own upload is: the queen serves the reads either way,
 * and a direct upload's every chunk waits on push-sync, which starves the
 * other files' direct uploads on the shared cluster.
 */
const DEFERRED = { deferred: true } as const

function randomPayload(size: number): Uint8Array {
  const data = new Uint8Array(size)
  // getRandomValues takes at most 65,536 bytes at a time
  const MAX_RANDOM_BYTES = 65_536
  for (let i = 0; i < size; i += MAX_RANDOM_BYTES) {
    crypto.getRandomValues(data.subarray(i, i + MAX_RANDOM_BYTES))
  }
  return data
}

describe("erasure-coded uploads against live cluster", () => {
  let bee: Bee
  let target: UploadTarget
  let batchId: string

  beforeAll(() => {
    batchId = inject("clusterBatchId")
    ;({ bee, target } = createClusterContext(batchId))
  })

  for (const level of LEVELS) {
    it(
      `agrees with Bee on the reference of a lone last leaf at level ${level}`,
      async () => {
        const data = randomPayload(loneLastLeaf(level, false))

        const ours = await uploadData(target, data, {
          ...DEFERRED,
          redundancyLevel: level,
        })
        const bees = await bee.data.upload(batchId, data, {
          redundancyLevel: level,
        })

        expect(ours.reference).toBe(bees.reference.toHex())
        expect(
          (await bee.data.download(ours.reference)).toUint8Array(),
        ).toEqual(data)
      },
      UPLOAD_TIMEOUT_MS,
    )
  }

  it(
    "agrees with Bee over the chunk stream too",
    async () => {
      const data = randomPayload(ONE_BATCH)

      const ours = await uploadData(target, data, {
        ...DEFERRED,
        redundancyLevel: 1,
        webSocket: {},
      })
      const bees = await bee.data.upload(batchId, data, { redundancyLevel: 1 })

      expect(ours.reference).toBe(bees.reference.toHex())
      expect((await bee.data.download(ours.reference)).toUint8Array()).toEqual(
        data,
      )
    },
    UPLOAD_TIMEOUT_MS,
  )

  it(
    "reads back through Bee an encrypted upload it erasure-coded",
    async () => {
      const data = randomPayload(loneLastLeaf(1, true))

      const { reference } = await uploadData(target, data, {
        ...DEFERRED,
        redundancyLevel: 1,
        encryptionKey: true,
      })

      expect((await bee.data.download(reference)).toUint8Array()).toEqual(data)
      expect(await downloadDataWithChunkAPI(bee, reference)).toEqual(data)
    },
    UPLOAD_TIMEOUT_MS,
  )

  it(
    "reads an upload Bee erasure-coded",
    async () => {
      const data = randomPayload(loneLastLeaf(2, true))

      const { reference } = await bee.data.upload(batchId, data, {
        redundancyLevel: 2,
        encrypt: true,
      })

      expect(await downloadDataWithChunkAPI(bee, reference.toHex())).toEqual(
        data,
      )
    },
    UPLOAD_TIMEOUT_MS,
  )
})

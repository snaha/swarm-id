// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Erasure-coded uploads against a live Bee (#307): the tree the library builds
 * at a redundancy level is the one Bee builds, so the two agree on a plain
 * upload's reference, and each reads back what the other wrote.
 */

import { describe, it, expect, beforeAll, inject } from "vitest"
import type { Bee } from "@ethersphere/bee-js"
import {
  ChunkBuilder,
  getMaxShards,
  makeReplicas,
  MantarayNode,
} from "@ethersphere/core-sdk"
import { uploadCollection } from "../../src/proxy/collection"
import { hexToUint8Array, uint8ArrayToHex } from "../../src/utils/hex"
import { uploadData, type UploadTarget } from "../../src/proxy/upload"
import { downloadDataWithChunkAPI } from "../../src/proxy/download-data"
import { CHUNK_SIZE, replicaCount } from "../../src/proxy/chunking"
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
const BATCH_LEAVES = 10
const ONE_BATCH = BATCH_LEAVES * CHUNK_SIZE
const UPLOAD_TIMEOUT_MS = 120_000
/**
 * Deferred, as bee-js's own upload is: the queen serves the reads either way,
 * and a direct upload's every chunk waits on push-sync, which starves the
 * other files' direct uploads on the shared cluster.
 */
const DEFERRED = { deferred: true } as const
const SPAN_BYTES = 8
/** Under a chunk: each file is its own tree's root */
const SMALL_FILE_BYTES = 100

function randomPayload(size: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(size)
  // getRandomValues takes at most 65,536 bytes at a time
  const MAX_RANDOM_BYTES = 65_536
  for (let i = 0; i < size; i += MAX_RANDOM_BYTES) {
    crypto.getRandomValues(data.subarray(i, i + MAX_RANDOM_BYTES))
  }
  return data
}

/** How many of `reference`'s replicas at `level` the node serves */
async function replicasServed(
  bee: Bee,
  reference: string,
  level: RedundancyLevel,
): Promise<{ expected: number; served: number }> {
  const chunk = (await bee.chunk.download(reference)).slice()
  const stored = new ChunkBuilder(
    new DataView(chunk.buffer).getBigUint64(0, true),
  )
  stored.writer.buffer.set(chunk.subarray(SPAN_BYTES))
  const replicas = makeReplicas(stored, level)
  let served = 0
  for (const { address } of replicas) {
    try {
      await bee.chunk.download(address.toHex())
      served++
    } catch {
      // not served
    }
  }
  return { expected: replicas.length, served }
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
    "replicates every manifest node and file root of a folder, as Bee does",
    async () => {
      const level = 2
      const files = [
        { path: "index.html", data: randomPayload(SMALL_FILE_BYTES) },
        { path: "assets/app.js", data: randomPayload(2 * SMALL_FILE_BYTES) },
      ]

      const { reference } = await uploadCollection(target, files, {
        ...DEFERRED,
        redundancyLevel: level,
        encrypt: false,
      })

      // Walk the manifest: every node, and every file root it points at
      const references = [reference]
      const nodes = [
        MantarayNode.unmarshalFromData(
          (await bee.chunk.download(reference)).slice(SPAN_BYTES),
          hexToUint8Array(reference),
        ),
      ]
      while (nodes.length > 0) {
        const node = nodes.pop()
        for (const fork of node?.forks.values() ?? []) {
          const address = fork.node.selfAddress ?? new Uint8Array()
          references.push(uint8ArrayToHex(address))
          const child = MantarayNode.unmarshalFromData(
            (await bee.chunk.download(uint8ArrayToHex(address))).slice(
              SPAN_BYTES,
            ),
            address,
          )
          const target = child.targetAddress
          if (target && target.some((byte) => byte !== 0)) {
            references.push(uint8ArrayToHex(target))
          }
          nodes.push(child)
        }
      }

      expect(references.length).toBeGreaterThan(files.length + 1)
      for (const ref of references) {
        expect(await replicasServed(bee, ref, level)).toEqual({
          expected: replicaCount(level),
          served: replicaCount(level),
        })
      }
    },
    UPLOAD_TIMEOUT_MS,
  )

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

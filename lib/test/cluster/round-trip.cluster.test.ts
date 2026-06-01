// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * POC integration test (#302): exercise the library's real Swarm operations
 * against a live local Bee cluster started with `@snaha/bee-compose`.
 *
 * Run with:
 *   pnpm dev:bee:detach   # from the repo root, starts the cluster
 *   pnpm --filter @snaha/swarm-id test:cluster
 *
 * The whole suite is skipped automatically when no cluster is reachable, so it
 * never breaks the default unit-test run or CI.
 *
 * Each test uploads a freshly randomised payload, so tests share one cluster
 * and one stamp without depending on each other's data.
 */

import { describe, it, expect, beforeAll } from "vitest"
import type { Bee, Stamper } from "@ethersphere/bee-js"
import { uploadData, type UploadTarget } from "../../src/proxy/upload"
import { downloadDataWithChunkAPI } from "../../src/proxy/download-data"
import {
  isClusterReachable,
  buyUsableStamp,
  createQueenStamper,
  createQueenBee,
} from "./cluster"

const clusterReachable = await isClusterReachable()

if (!clusterReachable) {
  // eslint-disable-next-line no-console
  console.warn(
    "[cluster] No local Bee cluster reachable at http://localhost:1633 — skipping cluster integration tests. Run `pnpm dev:bee:detach` to enable them.",
  )
}

/** Generate a unique random payload so each test is independent. */
function randomPayload(size: number): Uint8Array {
  const data = new Uint8Array(size)
  crypto.getRandomValues(data)
  return data
}

const SMALL_PAYLOAD_SIZE = 64
const MULTI_CHUNK_PAYLOAD_SIZE = 10_000

describe.skipIf(!clusterReachable)(
  "Swarm round-trip against live cluster",
  () => {
    let bee: Bee
    let stamper: Stamper
    let target: UploadTarget

    beforeAll(async () => {
      bee = createQueenBee()
      const batchId = await buyUsableStamp()
      stamper = createQueenStamper(batchId)
      target = { mode: "stamper", bee, stamper }
    }, 120_000)

    it("uploads and downloads small plain data", async () => {
      const data = randomPayload(SMALL_PAYLOAD_SIZE)

      const { reference } = await uploadData(target, data)
      expect(reference).toMatch(/^[0-9a-f]{64}$/)

      const downloaded = await downloadDataWithChunkAPI(bee, reference)
      expect(downloaded).toEqual(data)
    })

    it("uploads and downloads multi-chunk plain data", async () => {
      const data = randomPayload(MULTI_CHUNK_PAYLOAD_SIZE)

      const { reference } = await uploadData(target, data)
      const downloaded = await downloadDataWithChunkAPI(bee, reference)

      expect(downloaded).toEqual(data)
    })

    it("uploads and downloads encrypted data", async () => {
      const data = randomPayload(MULTI_CHUNK_PAYLOAD_SIZE)

      const { reference } = await uploadData(target, data, {
        encryptionKey: true,
      })
      // Encrypted references are 64 bytes (data ref + encryption key).
      expect(reference).toMatch(/^[0-9a-f]{128}$/)

      const downloaded = await downloadDataWithChunkAPI(bee, reference)
      expect(downloaded).toEqual(data)
    })
  },
)

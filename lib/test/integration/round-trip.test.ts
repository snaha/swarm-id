// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test (#302): exercise the library's real Swarm operations
 * against a live local Bee node started with `@snaha/bee-compose`.
 *
 * Run with:
 *   pnpm dev:bee:detach   # from the repo root, starts the cluster
 *   pnpm --filter @snaha/swarm-id test:integration
 *
 * The whole suite is skipped automatically when no cluster is reachable, so it
 * never breaks the default unit-test run or CI.
 *
 * The usable postage stamp is acquired once in global setup and shared with
 * every test file via inject("clusterBatchId"); each test uploads a freshly
 * randomised payload, so tests are independent.
 */

import { describe, it, expect, beforeAll, inject } from "vitest"
import type { Bee } from "@ethersphere/bee-js"
import { uploadData, type UploadTarget } from "../../src/proxy/upload"
import { downloadDataWithChunkAPI } from "../../src/proxy/download-data"
import { isClusterReachable, createClusterContext } from "./cluster"

const clusterReachable = await isClusterReachable()

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
    let target: UploadTarget

    beforeAll(() => {
      ;({ bee, target } = createClusterContext(inject("clusterBatchId")))
    })

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

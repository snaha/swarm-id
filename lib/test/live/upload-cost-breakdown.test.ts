// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Empirically breaks down a held-lease SOC upload into its phases, to verify
 * WHERE the browser's multi-second upload time actually goes (op vs publish) and
 * whether the per-upload `publishState` is the regression.
 *
 * Drives the SAME path the demo's "Upload SOC" button uses:
 * `coordinator.withWrite(op => uploadSOC(...))` with an ENCRYPTED SOC
 * (`encryptionKey: true`), persistent mode. Per upload it logs:
 *   - preOp  : call → op start (lease check; should be ~0 within the window)
 *   - op     : the SOC chunk write itself (one non-deferred write + receipt)
 *   - post   : op end → withWrite resolve  ≈ publishState (+ stamper flush)
 *
 * Expectation under test: upload-1's `post` is large (FULL 32-chunk publish,
 * no cached refs yet); upload-2+ `post` is smaller (incremental). Comparing
 * `op` vs `post` shows whether the SOC write or the added publish dominates.
 * Opt-in; skips without a `.env`.
 */

import { randomBytes } from "node:crypto"
import { describe, it, expect, beforeAll } from "vitest"
import { Identifier, PrivateKey } from "@ethersphere/bee-js"
import { BatchWriteCoordinator } from "../../src/sync/batch-write-coordinator"
import {
  UtilizationAwareStamper,
  PARTITION_COUNT,
} from "../../src/utils/batch-utilization"
import { uploadSOC, type UploadTarget } from "../../src/proxy/upload"
import { hexToUint8Array } from "../../src/utils/hex"
import {
  liveEnv,
  createContext,
  deriveAgentKeys,
  deviceId,
  type LiveContext,
  makeInMemoryCache,
} from "./env"

describe.skipIf(!liveEnv.configured)(
  "live — held-lease upload cost breakdown (op vs publish)",
  () => {
    let ctx: LiveContext
    let keys: Awaited<ReturnType<typeof deriveAgentKeys>>
    let D: string

    beforeAll(async () => {
      ctx = createContext()
      keys = await deriveAgentKeys()
      D = deviceId("device-solo")
      console.log(`account ${keys.accountId}  device ${D}`)
    })

    it("breaks down 4 sequential held-lease uploads into preOp/op/post", async () => {
      const encryptionKey = hexToUint8Array(keys.encryptionKey)
      const stamper = await UtilizationAwareStamper.create(
        ctx.signerKey.toHex(),
        ctx.batchID,
        ctx.depth,
        makeInMemoryCache(),
        keys.owner,
        encryptionKey,
      )
      const coordinator = new BatchWriteCoordinator({
        bee: ctx.bee,
        leaseStamper: stamper,
        deviceId: D,
        accountId: keys.accountId,
        knownDeviceIds: () => [D],
        backupSigner: keys.accountKey,
        swarmEncryptionKey: encryptionKey,
        partitionCount: PARTITION_COUNT,
        mode: "persistent", // match the demo's proxy coordinator
        flushStamperState: (s) => s.flush(),
      })

      const socSigner = new PrivateKey(randomBytes(32))
      const rows: string[] = []

      const measure = async (label: string): Promise<void> => {
        const callTime = Date.now()
        let opStart = 0
        let opEnd = 0
        const result = await coordinator.withWrite(
          stamper,
          async (target: UploadTarget) => {
            opStart = Date.now()
            // Encrypted SOC — exactly what the demo's "Upload SOC" sends.
            const r = await uploadSOC(
              target,
              socSigner,
              new Identifier(randomBytes(32)),
              randomBytes(64),
              { encryptionKey: true },
            )
            opEnd = Date.now()
            return r
          },
          { wait: "block" },
        )
        const end = Date.now()
        expect(result.socAddress?.length).toBe(32)
        rows.push(
          `  ${label.padEnd(10)} preOp=${String(opStart - callTime).padStart(6)}ms` +
            `  op=${String(opEnd - opStart).padStart(6)}ms` +
            `  post(publish+flush)=${String(end - opEnd).padStart(6)}ms` +
            `  total=${String(end - callTime).padStart(6)}ms`,
        )
      }

      await measure("upload-1") // acquires + FULL publish
      await measure("upload-2") // held + incremental publish
      await measure("upload-3") // held + incremental publish
      await measure("upload-4") // held + incremental publish

      console.log(
        "\n  ⏱  held-lease upload cost breakdown:\n" + rows.join("\n") + "\n",
      )

      // Sanity: every upload produced a SOC. The numbers above are the
      // verification deliverable (op = the SOC write; post = the per-upload
      // partition-state publish this branch added).
      expect(rows).toHaveLength(4)
    })
  },
)

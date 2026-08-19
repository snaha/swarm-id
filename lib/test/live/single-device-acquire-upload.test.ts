// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Single-device timing scenario (concern A — the demo's hot path).
 *
 * From a CLEAN account where no device holds a partition (the page-reload case),
 * one device drives the REAL `BatchWriteCoordinator.withWrite` path — acquire a
 * partition → upload a random SOC → publish partition-state — exactly what the
 * proxy does for the demo's "upload SOC" button. It prints the per-phase wall
 * times so we can see whether the acquire/upload latency work paid off:
 *
 *   - roster fold  : the device-registry read `acquire` fires NON-blocking
 *                    (`refreshKnownDeviceIds`); shown separately so its cost is
 *                    visibly OFF the acquire path.
 *   - acquire      : rotating state-pointer acquire from clean state.
 *   - upload       : the random SOC.
 *   - publish      : the incremental/parallel state-pointer publish (+ flush).
 *
 * BENCHMARK MODE: `ACQUIRE_RUNS=N` repeats the whole scenario N times, each run
 * on a FRESH throwaway account (so every acquire is genuinely cold — no lock,
 * no pointer, no counter state), and prints min/median/mean/max across runs.
 * Used to compare acquire-latency work before/after (see the plan/PR).
 *
 * Coordinator-level (not just `PartitionLease`) so it exercises everything the
 * demo exercises. Node-feasible: the util-aware stamper takes an in-memory
 * `UtilizationStoreDB` (no IndexedDB), the cross-tab lock no-ops without
 * `navigator.locks`. Opt-in; skips without a `.env` (see README).
 */

import { randomBytes } from "node:crypto"
import { describe, it, expect, beforeAll } from "vitest"
import { Identifier, PrivateKey } from "@ethersphere/bee-js"
import { BatchWriteCoordinator } from "../../src/sync/batch-write-coordinator"
import {
  UtilizationAwareStamper,
  PARTITION_COUNT,
} from "../../src/utils/batch-utilization"
import { readRoster } from "../../src/sync/device-roster"
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

/** Per-run wall times (ms). */
interface RunTimings {
  acquireMs: number
  uploadMs: number
  publishMs: number
  totalMs: number
  rosterMs: number
}

/** Budget per run — matches the suite's single-scenario expectations. */
const RUN_BUDGET_MS = 120_000

function stats(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return `min=${sorted[0]}  median=${median}  mean=${Math.round(mean)}  max=${sorted[sorted.length - 1]}`
}

describe.skipIf(!liveEnv.configured)(
  "live — single device: clean acquire + random SOC upload (timings)",
  () => {
    let ctx: LiveContext

    beforeAll(() => {
      ctx = createContext()
    })

    /** One full scenario on a FRESH account: acquire → SOC upload → publish. */
    async function runOnce(label: string): Promise<RunTimings> {
      const keys = await deriveAgentKeys()
      const D = deviceId("device-solo")
      console.log(`${label} account ${keys.accountId}  device ${D}`)

      const encryptionKey = hexToUint8Array(keys.encryptionKey)
      const cache = makeInMemoryCache()
      const stamper = await UtilizationAwareStamper.create(
        ctx.signerKey.toHex(),
        ctx.batchID,
        ctx.depth,
        cache,
        keys.owner,
        encryptionKey,
      )

      let acquiredAt = 0
      let uploadMs = 0
      let rosterMs = 0
      let rosterDone: Promise<void> = Promise.resolve()

      const coordinator = new BatchWriteCoordinator({
        bee: ctx.bee,
        leaseStamper: stamper,
        deviceId: D,
        accountId: keys.accountId,
        knownDeviceIds: () => [D],
        // Real device-registry fold — fired non-blocking by `acquire`. Timed so
        // we can see it does NOT gate the acquire below.
        refreshKnownDeviceIds: () => {
          const r0 = Date.now()
          rosterDone = readRoster({
            bee: ctx.bee,
            accountId: keys.accountId,
            owner: keys.owner,
          })
            .then(() => undefined)
            .catch(() => undefined)
            .finally(() => {
              rosterMs = Date.now() - r0
            })
          return rosterDone
        },
        backupSigner: keys.accountKey,
        swarmEncryptionKey: encryptionKey,
        partitionCount: PARTITION_COUNT,
        mode: "oneshot",
        flushStamperState: (s) => s.flush(),
        onLeaseAcquired: () => {
          acquiredAt = Date.now()
        },
      })

      // A random SOC (fresh signer + identifier + payload), stamped into the
      // acquired partition by the coordinator's bound stamper.
      const socSigner = new PrivateKey(randomBytes(32))
      const identifier = new Identifier(randomBytes(32))
      const payload = randomBytes(64)

      const t0 = Date.now()
      const result = await coordinator.withWrite(
        stamper,
        async (target: UploadTarget) => {
          const u0 = Date.now()
          const r = await uploadSOC(target, socSigner, identifier, payload, {})
          uploadMs = Date.now() - u0
          return r
        },
        { wait: "skip" },
      )
      const totalMs = Date.now() - t0
      await rosterDone // let the non-blocking fold settle so nothing dangles

      const acquireMs = acquiredAt - t0
      const publishMs = totalMs - acquireMs - uploadMs
      console.log(
        `\n  ⏱  ${label}  acquire=${acquireMs}ms  upload=${uploadMs}ms  ` +
          `publish≈${publishMs}ms  total=${totalMs}ms` +
          `  |  roster-fold(non-blocking)=${rosterMs}ms\n`,
      )

      expect(
        result.socAddress?.length,
        "SOC upload returned a 32-byte address",
      ).toBe(32)
      expect(
        coordinator.currentPartition,
        "a partition was acquired (not read-only)",
      ).not.toBeUndefined()
      // Regression guard: acquire must not crawl back toward the old 45s
      // feed-walk / lock-blocked stall.
      expect(acquireMs).toBeLessThan(45_000)

      return { acquireMs, uploadMs, publishMs, totalMs, rosterMs }
    }

    it(
      "acquires from a clean account and uploads a random SOC",
      async () => {
        const runs: RunTimings[] = []
        for (let i = 0; i < liveEnv.acquireRuns; i++) {
          runs.push(await runOnce(`run ${i + 1}/${liveEnv.acquireRuns}`))
        }

        if (runs.length > 1) {
          console.log(
            `\n  📊 single-device stats over ${runs.length} runs (ms)\n` +
              `     acquire: ${stats(runs.map((r) => r.acquireMs))}\n` +
              `     upload : ${stats(runs.map((r) => r.uploadMs))}\n` +
              `     publish: ${stats(runs.map((r) => r.publishMs))}\n` +
              `     total  : ${stats(runs.map((r) => r.totalMs))}\n`,
          )
        }
      },
      RUN_BUDGET_MS * Math.max(1, liveEnv.acquireRuns),
    )
  },
)

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-device acquire + SOC-upload TIMINGS (two devices share one batch).
 *
 * The single-device counterpart (`single-device-acquire-upload.test.ts`) times
 * one device's clean acquire → upload → publish. This is the contended version:
 * two devices (A, B) of one account each drive the REAL
 * `BatchWriteCoordinator.withWrite(uploadSOC)` path — the demo's "Upload SOC"
 * button — taking the two write partitions (K = PARTITION_COUNT = 2). It prints
 * per-device wall times for the cold first upload, then a COLD RE-ACQUIRE: B
 * idles past its 30s lease TTL (A kept alive by periodic keep-alive uploads), so
 * B's next upload pays a fresh acquire again — the partition-handoff case the
 * user feels as a slow "first upload after a while".
 *
 * Per upload it prints:
 *   - acquire : fresh partition acquire (0 when the lease was still held)
 *   - upload  : the SOC chunk write itself
 *   - publish : the incremental partition-state publish (+ stamper flush)
 *
 * `mode: "oneshot"` (no eager acquire, no refresh tick) so acquire happens
 * lazily inside `withWrite` and the timing isolates "press button → done".
 * Correctness guard: A and B never believe they hold the same partition. Opt-in;
 * skips without a `.env` (see README).
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
  delay,
  type LiveContext,
  makeInMemoryCache,
} from "./env"

interface DeviceHarness {
  id: string
  coordinator: BatchWriteCoordinator
  /** Set by `onLeaseAcquired` so a fresh acquire can be timed off the call. */
  state: { acquiredAt: number }
}

interface UploadTiming {
  partition: number | undefined
  acquireMs: number
  uploadMs: number
  publishMs: number
  totalMs: number
  socAddress?: Uint8Array
}

describe.skipIf(!liveEnv.configured)(
  "live — acquire + SOC upload timings (2 devices, 2 partitions)",
  () => {
    let ctx: LiveContext
    let keys: Awaited<ReturnType<typeof deriveAgentKeys>>
    let A: DeviceHarness
    let B: DeviceHarness
    let aFirst: UploadTiming
    let bFirst: UploadTiming

    const makeHarness = async (
      id: string,
      allDeviceIds: string[],
    ): Promise<DeviceHarness> => {
      const encryptionKey = hexToUint8Array(keys.encryptionKey)
      const stamper = await UtilizationAwareStamper.create(
        ctx.signerKey.toHex(),
        ctx.batchID,
        ctx.depth,
        makeInMemoryCache(),
        keys.owner,
        encryptionKey,
      )
      const state = { acquiredAt: 0 }
      const coordinator = new BatchWriteCoordinator({
        bee: ctx.bee,
        batchId: ctx.batchID.toHex(),
        stamper,
        deviceId: id,
        accountId: keys.accountId,
        // Both devices are known rivals → a fresh claim runs the intent round
        // (rotating addresses) so they deconflict on the gateway.
        knownDeviceIds: () => allDeviceIds,
        backupSigner: keys.accountKey,
        swarmEncryptionKey: encryptionKey,
        partitionCount: PARTITION_COUNT,
        mode: "oneshot", // lazy acquire inside withWrite → clean per-call timing
        intentGuardWindowMs: liveEnv.intentWindowMs,
        flushStamperState: () => stamper.flush(),
        onLeaseAcquired: () => {
          state.acquiredAt = Date.now()
        },
      })
      return { id, coordinator, state }
    }

    // One SOC upload of a random chunk through the real write path, timed.
    const uploadOn = async (
      h: DeviceHarness,
      label: string,
    ): Promise<UploadTiming> => {
      const socSigner = new PrivateKey(randomBytes(32))
      h.state.acquiredAt = 0 // reset; set only if a fresh acquire fires
      let uploadMs = 0
      const t0 = Date.now()
      const result = await h.coordinator.withWrite(
        async (target: UploadTarget) => {
          const u0 = Date.now()
          const r = await uploadSOC(
            target,
            socSigner,
            new Identifier(randomBytes(32)),
            randomBytes(64),
            {},
          )
          uploadMs = Date.now() - u0
          return r
        },
        { wait: "skip" },
      )
      const totalMs = Date.now() - t0
      // acquiredAt is 0 when the lease was still held (no fresh acquire), so
      // acquireMs reads 0 and the whole call is upload + publish.
      const acquireMs = h.state.acquiredAt ? h.state.acquiredAt - t0 : 0
      const publishMs = totalMs - acquireMs - uploadMs
      console.log(
        `  ⏱  ${label.padEnd(16)} partition=${h.coordinator.currentPartition}` +
          `  acquire=${String(acquireMs).padStart(6)}ms` +
          `  upload=${String(uploadMs).padStart(6)}ms` +
          `  publish≈${String(publishMs).padStart(6)}ms` +
          `  total=${String(totalMs).padStart(6)}ms`,
      )
      return {
        partition: h.coordinator.currentPartition,
        acquireMs,
        uploadMs,
        publishMs,
        totalMs,
        socAddress: result.socAddress,
      }
    }

    beforeAll(async () => {
      ctx = createContext()
      keys = await deriveAgentKeys()
      const aId = deviceId("device-a")
      const bId = deviceId("device-b")
      const all = [aId, bId]
      A = await makeHarness(aId, all)
      B = await makeHarness(bId, all)
      console.log(`account ${keys.accountId}  A=${aId} B=${bId}`)
    })

    it("A: cold acquire + SOC upload", async () => {
      aFirst = await uploadOn(A, "A first")
      expect(aFirst.socAddress?.length, "A's SOC uploaded").toBe(32)
      expect(aFirst.partition, "A acquired a partition").not.toBeUndefined()
      await delay(liveEnv.acquireGapMs) // let A's lock be readable to B
    })

    it("B: cold acquire of the OTHER partition + SOC upload (no double-grab)", async () => {
      bFirst = await uploadOn(B, "B first")
      expect(bFirst.socAddress?.length, "B's SOC uploaded").toBe(32)
      expect(bFirst.partition, "B acquired a partition").not.toBeUndefined()
      expect(bFirst.partition, "B took the OTHER partition").not.toBe(
        aFirst.partition,
      )
    })

    it("B: upload after idling past its lease TTL (A kept alive)", async () => {
      // Keep A's lease alive with periodic keep-alive uploads while B idles past
      // its 30s TTL. NOTE: on the public gateway a device's own lock SOC stays
      // negative-cached ~50s, so with the default ~38s idle B usually RE-VALIDATES
      // its still-readable lock (acquire=0) rather than paying a fresh acquire; a
      // genuine cold re-acquire needs idle > the cache window (raise IDLE_MS). The
      // no-dual-grab guard below holds either way.
      const end = Date.now() + liveEnv.idleMs
      while (Date.now() < end) {
        await delay(Math.min(liveEnv.keepAliveEveryMs, end - Date.now()))
        await uploadOn(A, "A keep-alive")
      }

      const bReacq = await uploadOn(B, "B post-idle")
      console.log(
        `\n  summary: A first total=${aFirst.totalMs}ms (acquire=${aFirst.acquireMs}ms)` +
          `  B first total=${bFirst.totalMs}ms (acquire=${bFirst.acquireMs}ms)` +
          `  B post-idle total=${bReacq.totalMs}ms (acquire=${bReacq.acquireMs}ms)\n`,
      )

      expect(bReacq.socAddress?.length, "B's re-acquire SOC uploaded").toBe(32)
      expect(bReacq.partition, "B re-acquired a partition").not.toBeUndefined()
      // Correctness guard: B must not land on the partition A still holds.
      expect(
        bReacq.partition,
        "B did not dual-grab A's still-held partition",
      ).not.toBe(A.coordinator.currentPartition)
    })
  },
)

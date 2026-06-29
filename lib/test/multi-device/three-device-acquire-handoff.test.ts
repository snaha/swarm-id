// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Three-device acquire → SOC-upload HANDOFF timings (one account, K = 2).
 *
 * Extends the two-device timing test (`multi-device-acquire-upload.test.ts`) to
 * three devices. With production PARTITION_COUNT = 2, A and B take the two write
 * partitions (A→p0, B→p1, deterministic via `deviceHomePartition`) and each
 * uploads a SOC through the REAL `BatchWriteCoordinator.withWrite(uploadSOC)`
 * path. C cannot acquire while both are held — so the test runs a full p1
 * handoff CYCLE, A holding p0 throughout:
 *   1. B idles past its lease TTL (A kept alive) → C takes over the freed p1.
 *   2. C idles in turn → B reclaims p1 from a fresh same-deviceId coordinator
 *      (the page-reload path: cold acquire + intent round + resume of C's state).
 * This exercises the "takes over an expired foreign holder" path live in both
 * directions, with per-device acquire/upload/publish wall times.
 *
 * `mode: "oneshot"` (no eager acquire, no refresh tick) so acquire happens
 * lazily inside `withWrite` and the timing isolates "press button → done"; A is
 * `persistent` so its refresh tick keeps p0's lock fresh on Swarm across both
 * idles. Correctness guard: no two devices ever believe they hold the same
 * partition. Opt-in; skips without a `.env` (see README).
 */

import { randomBytes } from "node:crypto"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Identifier, PrivateKey } from "@ethersphere/bee-js"
import {
  BatchWriteCoordinator,
  type CoordinatorMode,
} from "../../src/sync/batch-write-coordinator"
import {
  UtilizationAwareStamper,
  PARTITION_COUNT,
  LEASE_TTL_MS,
} from "../../src/utils/batch-utilization"
import { deviceHomePartition } from "../../src/sync/partition-lock"
import { INTENT_LIVENESS_GRACE_MS } from "../../src/sync/partition-intent"
import type {
  BatchMetadata,
  ChunkCacheEntry,
  UtilizationStoreDB,
} from "../../src/storage/utilization-store"
import { uploadSOC, type UploadTarget } from "../../src/proxy/upload"
import { hexToUint8Array } from "../../src/utils/hex"
import {
  multiDeviceEnv,
  createContext,
  deriveAgentKeys,
  deviceId,
  delay,
  type MultiDeviceContext,
} from "./env"

// B must be gone long enough that C sees p1 free on EVERY channel: the lock SOC
// (expires at TTL) AND B's occupancy beacon (treated as live for a further
// INTENT_LIVENESS_GRACE_MS after B's last heartbeat). B never refreshes, so its
// last heartbeat is its acquire ≈ the idle start; wait TTL + grace + margin.
const HANDOFF_IDLE_MS = LEASE_TTL_MS + INTENT_LIVENESS_GRACE_MS + 12_000

/** Minimal in-memory `UtilizationStoreDB` (no IndexedDB), per the unit suite. */
function makeInMemoryCache(): UtilizationStoreDB {
  const chunks = new Map<string, ChunkCacheEntry>()
  const meta = new Map<string, BatchMetadata>()
  return {
    getAllChunks: async (batchId: string) =>
      Array.from(chunks.values())
        .filter((c) => c.batchId === batchId)
        .sort((a, b) => a.chunkIndex - b.chunkIndex),
    putChunk: async (entry: ChunkCacheEntry) => {
      chunks.set(`${entry.batchId}:${entry.chunkIndex}`, { ...entry })
    },
    getChunk: async (batchId: string, chunkIndex: number) =>
      chunks.get(`${batchId}:${chunkIndex}`),
    getMetadata: async (batchId: string) => meta.get(batchId),
    putMetadata: async (metadata: BatchMetadata) => {
      meta.set(metadata.batchId, { ...metadata })
    },
  } as unknown as UtilizationStoreDB
}

/** A device id whose deterministic home partition is `target` (so A→p0, B→p1). */
function deviceIdForHome(prefix: string, target: number): string {
  for (;;) {
    const id = deviceId(prefix)
    if (deviceHomePartition(id, PARTITION_COUNT) === target) return id
  }
}

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

describe.skipIf(!multiDeviceEnv.configured)(
  "multi-device — 3 devices: A→p0, B→p1, handoff to C (acquire + upload timings)",
  () => {
    let ctx: MultiDeviceContext
    let keys: Awaited<ReturnType<typeof deriveAgentKeys>>
    let aId: string
    let bId: string
    let all: string[]
    let A: DeviceHarness
    let B: DeviceHarness
    let C: DeviceHarness
    let aFirst: UploadTiming
    let bFirst: UploadTiming
    let cTakeover: UploadTiming

    const makeHarness = async (
      id: string,
      allDeviceIds: string[],
      mode: CoordinatorMode,
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
        // All three are known rivals → a fresh claim runs the intent round
        // (rotating addresses) so they deconflict on the gateway.
        knownDeviceIds: () => allDeviceIds,
        backupSigner: keys.accountKey,
        swarmEncryptionKey: encryptionKey,
        partitionCount: PARTITION_COUNT,
        // oneshot: lazy acquire inside withWrite → clean per-call timing.
        // persistent (A): same lazy first acquire, but ALSO arms the refresh tick
        // that rewrites the lock SOC on Swarm every ~10s — without it a held
        // device's on-gateway lease still expires after 30s and a peer takes over.
        mode,
        intentGuardWindowMs: multiDeviceEnv.intentWindowMs,
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
      aId = deviceIdForHome("device-a", 0) // home p0
      bId = deviceIdForHome("device-b", 1) // home p1
      const cId = deviceId("device-c") // takes whatever frees
      all = [aId, bId, cId]
      // A is "persistent" so its refresh tick keeps p0's lock fresh on Swarm
      // while B idles and C takes over p1; B and C are "oneshot" for clean
      // per-call acquire timing.
      A = await makeHarness(aId, all, "persistent")
      B = await makeHarness(bId, all, "oneshot")
      C = await makeHarness(cId, all, "oneshot")
      console.log(`account ${keys.accountId}  A=${aId} B=${bId} C=${cId}`)
    })

    afterAll(() => {
      // Clear A's refresh interval (persistent) so it doesn't outlive the run.
      A?.coordinator.teardown()
      B?.coordinator.teardown()
      C?.coordinator.teardown()
    })

    it("A: acquires p0 + SOC upload", async () => {
      aFirst = await uploadOn(A, "A p0")
      expect(aFirst.socAddress?.length, "A's SOC uploaded").toBe(32)
      expect(aFirst.partition, "A acquired its home partition p0").toBe(0)
      await delay(multiDeviceEnv.acquireGapMs) // let A's lock be readable to B
    })

    it("B: acquires p1 + SOC upload (no double-grab)", async () => {
      bFirst = await uploadOn(B, "B p1")
      expect(bFirst.socAddress?.length, "B's SOC uploaded").toBe(32)
      expect(bFirst.partition, "B acquired its home partition p1").toBe(1)
      expect(bFirst.partition, "B took the OTHER partition").not.toBe(
        aFirst.partition,
      )
      await delay(multiDeviceEnv.acquireGapMs)
    })

    it("C: takes over the freed partition + SOC upload after B idles past its TTL", async () => {
      // Keep A alive with periodic keep-alive uploads (every keepAliveEveryMs <
      // A's 30s idle-yield window) while B idles long enough for its lock AND
      // occupancy beacon to age out, so p1 frees for C to take over.
      const end = Date.now() + HANDOFF_IDLE_MS
      while (Date.now() < end) {
        await delay(Math.min(multiDeviceEnv.keepAliveEveryMs, end - Date.now()))
        await uploadOn(A, "A keep-alive")
      }

      cTakeover = await uploadOn(C, "C takeover")

      expect(cTakeover.socAddress?.length, "C's SOC uploaded").toBe(32)
      expect(cTakeover.partition, "C acquired a partition").not.toBeUndefined()
      // C takes over B's freed slot (p1), while A still holds p0.
      expect(cTakeover.partition, "C took over B's freed partition").toBe(
        bFirst.partition,
      )
      expect(A.coordinator.currentPartition, "A still holds p0").toBe(
        aFirst.partition,
      )
      // The regression guard: no two devices believe they hold the same slot.
      expect(
        cTakeover.partition,
        "C did not dual-grab A's still-held partition",
      ).not.toBe(A.coordinator.currentPartition)
    })

    it("B: reclaims its original partition (cold) after C idles out + SOC upload", async () => {
      // Now C idles (does nothing) while A stays alive, so C's p1 lock + occupancy
      // beacon age out and p1 frees again. B reclaims it from a FRESH coordinator
      // with the SAME deviceId — the page-reload path: no in-memory lease, so it
      // re-runs the full acquire (intent round + lock takeover of the expired
      // holder) and resumes C's published partition-state. (B's old coordinator
      // still holds a stale lease, and `isDisplaced` treats an EXPIRED foreign
      // holder as not-displaced — so reusing it would silently bump the stale
      // lease instead of re-acquiring; a fresh session is the honest reclaim.)
      const end = Date.now() + HANDOFF_IDLE_MS
      while (Date.now() < end) {
        await delay(Math.min(multiDeviceEnv.keepAliveEveryMs, end - Date.now()))
        await uploadOn(A, "A keep-alive")
      }

      B = await makeHarness(bId, all, "oneshot")
      const bReclaim = await uploadOn(B, "B reclaim")
      console.log(
        `\n  summary (p1 handoff cycle B→C→B):` +
          `  B p1 acquire=${bFirst.acquireMs}ms` +
          `  → C takeover acquire=${cTakeover.acquireMs}ms` +
          `  → B reclaim acquire=${bReclaim.acquireMs}ms total=${bReclaim.totalMs}ms\n`,
      )

      expect(bReclaim.socAddress?.length, "B's reclaim SOC uploaded").toBe(32)
      // B reclaims its original partition p1 — the same slot it handed to C.
      expect(bReclaim.partition, "B reclaimed its original partition p1").toBe(
        bFirst.partition,
      )
      expect(bReclaim.partition, "the same slot C had is handed back").toBe(
        cTakeover.partition,
      )
      // A real cold re-acquire (intent round + lock takeover), not a stale-lease
      // bump — a fresh coordinator has no lease, so onLeaseAcquired fired.
      expect(
        bReclaim.acquireMs,
        "B paid a genuine cold re-acquire",
      ).toBeGreaterThan(0)
      expect(A.coordinator.currentPartition, "A held p0 the whole cycle").toBe(
        aFirst.partition,
      )
      expect(
        bReclaim.partition,
        "B did not dual-grab A's still-held partition",
      ).not.toBe(A.coordinator.currentPartition)
    })
  },
)

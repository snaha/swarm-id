// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-device PARTITION contention (concern B) with 3 devices. K =
 * PARTITION_COUNT = 2, so only two devices can hold a write partition at once:
 * A and B take the two slots, C is read-only. Then the dual-acquire regression
 * beat: B goes idle so its 30s lease lapses (A kept alive meanwhile), a peer
 * takes the freed slot, B re-acquires — and must NOT end up sharing a partition
 * (the unknown-holder dual-acquire the occupancy beacon + self-refresh fixes
 * close). The deterministic version lives in
 * src/sync/partition-lease.integration.test.ts; this is the live counterpart.
 *
 * Timing caveat (public gateway): LEASE_TTL = 30s but the gateway negative-caches
 * a fresh lock-SOC address ~50s, so acquires run in quick succession and lean on
 * the rotating-address intent/occupancy SOCs. The asserted invariant is global —
 * no partition believed-held by two devices — which holds regardless of which
 * device ends up where. Opt-in; skips without a `.env` (see README).
 */

import { describe, it, expect, beforeAll } from "vitest"
import { Stamper } from "@ethersphere/bee-js"
import { PartitionLease } from "../../src/sync/partition-lease"
import { PARTITION_COUNT } from "../../src/utils/batch-utilization"
import { hexToUint8Array } from "../../src/utils/hex"
import {
  multiDeviceEnv,
  createContext,
  deriveAgentKeys,
  deviceId,
  delay,
  type MultiDeviceContext,
} from "./env"

interface AcquireResult {
  partition: number | undefined
  isReadOnly: boolean
  ms: number
}

describe.skipIf(!multiDeviceEnv.configured)(
  "multi-device — 3 devices race for 2 partitions",
  () => {
    let ctx: MultiDeviceContext
    let keys: Awaited<ReturnType<typeof deriveAgentKeys>>
    let A: string
    let B: string
    let C: string
    let leaseA: PartitionLease
    let leaseB: PartitionLease
    let leaseC: PartitionLease
    let a: AcquireResult
    let b: AcquireResult

    const makeLease = (id: string, allDevices: string[]) =>
      PartitionLease.fromSwarmEncryptionKey({
        bee: ctx.bee,
        deviceId: id,
        swarmEncryptionKey: hexToUint8Array(keys.encryptionKey),
        batchId: ctx.batchID,
        batchDepth: ctx.depth,
        stamper: Stamper.fromBlank(ctx.signerKey, ctx.batchID, ctx.depth),
        // All three are known rivals → fresh claims run the intent round
        // (rotating addresses), the gateway-safe path for deconfliction.
        knownDeviceIds: () => allDevices,
        guardMs: multiDeviceEnv.guardMs,
        intentGuardWindowMs: multiDeviceEnv.intentWindowMs,
      })

    const acquireOn = async (
      l: PartitionLease,
      label: string,
    ): Promise<AcquireResult> => {
      const t0 = Date.now()
      const res = await l.acquire({ partitionCount: PARTITION_COUNT })
      const ms = Date.now() - t0
      console.log(
        `  ⏱  ${label} acquire: ${res.partition === undefined ? "READ-ONLY" : "partition " + res.partition}  (${ms}ms)`,
      )
      return { partition: res.partition, isReadOnly: res.isReadOnly, ms }
    }

    beforeAll(async () => {
      ctx = createContext()
      keys = await deriveAgentKeys()
      A = deviceId("device-a")
      B = deviceId("device-b")
      C = deviceId("device-c")
      const all = [A, B, C]
      leaseA = await makeLease(A, all)
      leaseB = await makeLease(B, all)
      leaseC = await makeLease(C, all)
      console.log(`account ${keys.accountId}  A=${A} B=${B} C=${C}`)
    })

    it("A acquires a partition", async () => {
      a = await acquireOn(leaseA, "A")
      expect(a.partition).not.toBeUndefined()
      expect(a.isReadOnly).toBe(false)
      await delay(multiDeviceEnv.acquireGapMs)
    })

    it("B acquires the OTHER partition (no double-grab)", async () => {
      b = await acquireOn(leaseB, "B")
      expect(b.partition).not.toBeUndefined()
      expect(b.isReadOnly).toBe(false)
      expect(b.partition).not.toBe(a.partition)
      await delay(multiDeviceEnv.acquireGapMs)
    })

    it("C is read-only while both partitions are held", async () => {
      const c = await acquireOn(leaseC, "C")
      expect(c.isReadOnly).toBe(true)
      expect(c.partition).toBeUndefined()
    })

    it("idle-then-reacquire: B lapses, a peer takes its slot, no dual-acquire", async () => {
      // Keep A alive (refresh) while B idles past its 30s lease TTL.
      let aOutcome = "held"
      const end = Date.now() + multiDeviceEnv.idleMs
      while (Date.now() < end) {
        await delay(Math.min(multiDeviceEnv.keepAliveEveryMs, end - Date.now()))
        aOutcome = String(
          await leaseA.refresh().catch((e) => `error: ${e?.message ?? e}`),
        )
        console.log(`  A keep-alive refresh → ${aOutcome}`)
      }
      const aHolds = aOutcome === "held" ? a.partition : undefined

      const cReacq = await acquireOn(leaseC, "C")
      await delay(multiDeviceEnv.acquireGapMs)
      const bReacq = await acquireOn(leaseB, "B")

      const beliefs = [
        { dev: "A", p: aHolds },
        { dev: "B", p: bReacq.partition },
        { dev: "C", p: cReacq.partition },
      ].filter((x) => x.p !== undefined)
      console.log(
        `  final holdings: ${beliefs.map((x) => `${x.dev}=p${x.p}`).join("  ") || "(none)"}`,
      )

      const held = beliefs.map((x) => x.p)
      // THE regression guard: no partition believed-held by two devices.
      expect(
        new Set(held).size,
        "no two devices believe they hold the same partition",
      ).toBe(held.length)
    })
  },
)

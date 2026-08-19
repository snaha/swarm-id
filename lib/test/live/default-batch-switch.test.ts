// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live regression for the default-stamp-change + reload hazard: after the
 * account's default batch switches A→B, the rebuilt coordinator ADOPTS the
 * cached claim (free — the on-network claim is account-scoped) while seeding
 * B's counter from the NETWORK (local state describes A, not B; see
 * cross-batch-adopt.test.ts for the prior-holder edge that makes local
 * seeding dangerous) — and it must re-join A as a secondary, so A's state
 * pointer keeps being heartbeated. Without that, A's pointer ages out of
 * `readStatePointer`'s ~90s lookup span and a later cross-device takeover
 * resumes A from a ZERO counter, re-issuing acked slots.
 *
 * Needs TWO usable batches owned by SIGNER_KEY: the suite's BATCH_ID (A) plus
 * BATCH_ID_2 (B). Skips when either is absent. Reads the takeover through
 * PEER_BEE_URL when set (on a local cluster point it at a WORKER node — the
 * uploading node serves its own chunks from its local store and would mask
 * what a real peer sees).
 *
 * Local cluster example:
 *   BEE_URL=http://localhost:1633 PEER_BEE_URL=http://localhost:16331 \
 *   BATCH_ID=<A> BATCH_ID_2=<B> SIGNER_KEY=<queen key> DEPTH=20 \
 *   AGE_OUT_MS=120000 TAKEOVER_WAIT_MS=80000 \
 *   pnpm exec vitest run --config vitest.live.config.ts test/live/default-batch-switch.test.ts
 *
 * Runtime ≈ AGE_OUT_MS + TAKEOVER_WAIT_MS (+ overhead) — about 4 minutes with
 * the defaults.
 */

import { describe, it, expect } from "vitest"
import { randomBytes } from "node:crypto"
import { Bee, BatchId } from "@ethersphere/bee-js"
import {
  liveEnv,
  deriveAgentKeys,
  deviceId,
  delay,
  makeInMemoryCache,
} from "./env"
import { BatchWriteCoordinator } from "../../src/sync/batch-write-coordinator"
import { PartitionLease } from "../../src/sync/partition-lease"
import type { PartitionLeaseStateSnapshot } from "../../src/sync/partition-lease"
import { deviceHomePartition } from "../../src/sync/partition-lock"
import {
  UtilizationAwareStamper,
  LEASE_REFRESH_MS,
} from "../../src/utils/batch-utilization"
import { hexToUint8Array } from "../../src/utils/key-derivation"
import { uploadData } from "../../src/proxy/upload"
import type { Stamper } from "@ethersphere/bee-js"

const BATCH_B_HEX = process.env.BATCH_ID_2
const PEER_BEE_URL = process.env.PEER_BEE_URL ?? liveEnv.beeUrl
/** Hold past the pointer lookup span (~LEASE_TTL + 2 epochs ≈ 90s). */
const AGE_OUT_MS = Number(process.env.AGE_OUT_MS ?? 120_000)
/** Lock TTL + occupancy-beacon window must both lapse before a peer can claim. */
const TAKEOVER_WAIT_MS = Number(process.env.TAKEOVER_WAIT_MS ?? 80_000)
const PARTITION_COUNT = 2

type Internals = {
  pauseLeaseBackgroundWork: () => void
  joinedSecondaries: Map<string, unknown>
}
const internals = (c: BatchWriteCoordinator) => c as unknown as Internals

/** First `<prefix>-N` device id whose home partition is `target`. */
function deviceHomedAt(target: number, prefix: string): string {
  for (let i = 0; i < 1000; i++) {
    const candidate = `${prefix}-${i}`
    if (deviceHomePartition(candidate, PARTITION_COUNT) === target) {
      return candidate
    }
  }
  throw new Error(`no device id homed at partition ${target}`)
}

describe.skipIf(!liveEnv.configured || !BATCH_B_HEX)(
  "live — default-batch switch keeps the old batch's resume point alive",
  () => {
    it(
      "cold-acquires under the new batch, re-joins the old one, and a takeover resumes it at acked",
      { timeout: AGE_OUT_MS + TAKEOVER_WAIT_MS + 180_000 },
      async () => {
        const bee = new Bee(liveEnv.beeUrl)
        const peerBee = new Bee(PEER_BEE_URL)
        const batchA = new BatchId(liveEnv.batchIdHex!)
        const batchB = new BatchId(BATCH_B_HEX!)
        const keys = await deriveAgentKeys()
        const encryptionKey = hexToUint8Array(keys.encryptionKey)
        const D = deviceId("switch-a")
        // One store per device: the sessions before/after the "reload" share
        // this device's persisted utilization state, like IndexedDB would.
        const store = makeInMemoryCache()

        const makeStamper = (batch: BatchId) =>
          UtilizationAwareStamper.create(
            liveEnv.signerKeyHex!,
            batch,
            liveEnv.depth,
            store,
            keys.owner,
            encryptionKey,
          )

        let cache: PartitionLeaseStateSnapshot | undefined
        const commonDeps = {
          bee,
          deviceId: D,
          accountId: keys.accountId,
          backupSigner: keys.accountKey,
          swarmEncryptionKey: encryptionKey,
          partitionCount: PARTITION_COUNT,
          mode: "persistent" as const,
          knownDeviceIds: () => [D],
          intentGuardWindowMs: liveEnv.guardMs,
          readLeaseCache: () => cache,
          writeLeaseCache: (snap: PartitionLeaseStateSnapshot | undefined) => {
            if (snap) cache = snap
          },
          flushStamperState: (s: UtilizationAwareStamper) => s.flush(),
        }

        // ---- session 1: default batch is A; write A --------------------------
        const stamperA1 = await makeStamper(batchA)
        const session1 = new BatchWriteCoordinator({
          ...commonDeps,
          leaseStamper: stamperA1,
        })
        await session1.withWrite(
          stamperA1,
          (target) => uploadData(target, randomBytes(96)),
          { wait: "block" },
        )
        const partition = session1.currentPartition
        expect(partition).toBeDefined()
        const ackedA = stamperA1.getLocalCounter()!
        const probeBucket = ackedA.findIndex((v) => v > 0)
        expect(probeBucket).toBeGreaterThanOrEqual(0)
        const ackedCounter = ackedA[probeBucket]

        // ---- "reload" + default-stamp change to B ----------------------------
        const surviving = cache
        internals(session1).pauseLeaseBackgroundWork()
        cache = surviving

        const stamperA2 = await makeStamper(batchA)
        const stamperB = await makeStamper(batchB)
        const session2 = new BatchWriteCoordinator({
          ...commonDeps,
          leaseStamper: stamperB,
          resolveStamperForBatch: async (hex) =>
            hex === batchA.toHex() ? stamperA2 : undefined,
        })
        await session2.withWrite(
          stamperB,
          (target) => uploadData(target, randomBytes(96)),
          { wait: "block" },
        )
        await session2.joinedRestoreSettled

        // The old default was re-joined (locally seeded — the adopt proves the
        // lease never lapsed, so X's own state for A is the newest), and the
        // refresh tick heartbeats its pointer from here on.
        expect(internals(session2).joinedSecondaries.has(batchA.toHex())).toBe(
          true,
        )
        expect(session2.currentPartition).toBe(partition)

        // ---- hold past the pointer lookup span --------------------------------
        const until = Date.now() + AGE_OUT_MS
        while (Date.now() < until) {
          await delay(LEASE_REFRESH_MS)
          // Keep the holder non-idle (idle-yield is 30s) with B writes only —
          // batch A must survive on heartbeats alone.
          await session2.withWrite(
            stamperB,
            (target) => uploadData(target, randomBytes(64)),
            { wait: "block" },
          )
        }

        // ---- device C takes the partition over --------------------------------
        const final = cache
        internals(session2).pauseLeaseBackgroundWork()
        cache = final
        await delay(TAKEOVER_WAIT_MS)

        const C = deviceHomedAt(partition!, "switch-c")
        const peerLease = await PartitionLease.fromSwarmEncryptionKey({
          bee: peerBee,
          deviceId: C,
          batchId: batchB,
          batchDepth: liveEnv.depth,
          swarmEncryptionKey: encryptionKey,
          stamper: (await makeStamper(batchB)) as unknown as Stamper,
          knownDeviceIds: () => [D, C],
          intentGuardWindowMs: liveEnv.guardMs,
        })
        const claim = await peerLease.acquire({
          partitionCount: PARTITION_COUNT,
        })
        // Landing elsewhere would read a partition A never wrote — a zero that
        // proves nothing. Fail loudly rather than report a meaningless pass.
        expect(claim.partition).toBe(partition)

        // A NON-UtilizationAwareStamper context: device C has no local synced
        // reference to fall back on — it must find A's resume point on the
        // network, exactly like a real second device.
        const peerBatchAContext = {
          batchId: batchA,
          depth: liveEnv.depth,
        } as unknown as UtilizationAwareStamper
        const resumed = await peerLease.joinBatch(peerBatchAContext)
        await peerLease.release(resumed).catch(() => undefined)

        expect(resumed[probeBucket]).toBe(ackedCounter)
      },
    )
  },
)

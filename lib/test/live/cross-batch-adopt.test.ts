// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live regression for the cross-batch adopt's ONE dangerous edge: after a
 * default-stamp change A→B, the reloaded coordinator adopts the cached claim
 * for free (the on-network claim is account-scoped) — but the NEW lease batch
 * B may have been written at this very partition by a PRIOR HOLDER. This
 * device's local state for B is zero, so seeding the adopt from local state
 * (the pre-fix behaviour, sound only for the snapshot's own batch) would
 * full-publish (near) zero over the prior holder's resume point and re-issue
 * its acked slots. The adopt must instead seed B from the NETWORK
 * (`joinBatch`, bounded by the prior-holder span the snapshot carries).
 *
 * Flow: device Y holds partition p, writes batch B, releases. Device X
 * acquires p under batch A (the prior-holder span lands in X's lease cache),
 * writes A, "reloads" with its default switched to B — and must adopt with
 * B's counter resumed at Y's acked value, not zero.
 *
 * Fast (~1 min): no pointer age-out is involved — the hazard is at bind time.
 *
 * Needs BATCH_ID (A) + BATCH_ID_2 (B) owned by SIGNER_KEY; skips otherwise.
 *
 * Local cluster example:
 *   BEE_URL=http://localhost:1633 BATCH_ID=<A> BATCH_ID_2=<B> \
 *   SIGNER_KEY=<queen key> DEPTH=20 \
 *   pnpm exec vitest run --config vitest.live.config.ts test/live/cross-batch-adopt.test.ts
 */

import { describe, it, expect } from "vitest"
import { randomBytes } from "node:crypto"
import { Bee, BatchId } from "@ethersphere/bee-js"
import { liveEnv, deriveAgentKeys, delay, makeInMemoryCache } from "./env"
import { BatchWriteCoordinator } from "../../src/sync/batch-write-coordinator"
import type { PartitionLeaseStateSnapshot } from "../../src/sync/partition-lease"
import { deviceHomePartition } from "../../src/sync/partition-lock"
import { UtilizationAwareStamper } from "../../src/utils/batch-utilization"
import { hexToUint8Array } from "../../src/utils/key-derivation"
import { uploadData } from "../../src/proxy/upload"

const BATCH_B_HEX = process.env.BATCH_ID_2
const PARTITION_COUNT = 2

type Internals = { pauseLeaseBackgroundWork: () => void }
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
  "live — cross-batch adopt resumes the new lease batch at a prior holder's counter",
  () => {
    it(
      "adopts after a default switch with the new batch network-seeded, never zero",
      { timeout: 240_000 },
      async () => {
        const bee = new Bee(liveEnv.beeUrl)
        const batchA = new BatchId(liveEnv.batchIdHex!)
        const batchB = new BatchId(BATCH_B_HEX!)
        const keys = await deriveAgentKeys()
        const encryptionKey = hexToUint8Array(keys.encryptionKey)
        // Both devices home at partition 0 so Y's released claim is exactly
        // the one X acquires (and later adopts).
        const Y = deviceHomedAt(0, "prior")
        const X = deviceHomedAt(0, "adoptr")

        const makeStamper = (batch: BatchId) =>
          UtilizationAwareStamper.create(
            liveEnv.signerKeyHex!,
            batch,
            liveEnv.depth,
            makeInMemoryCache(),
            keys.owner,
            encryptionKey,
          )

        // ---- device Y: hold p0, write batch B, release --------------------
        const stamperYB = await makeStamper(batchB)
        const sessionY = new BatchWriteCoordinator({
          bee,
          leaseStamper: stamperYB,
          deviceId: Y,
          accountId: keys.accountId,
          backupSigner: keys.accountKey,
          swarmEncryptionKey: encryptionKey,
          partitionCount: PARTITION_COUNT,
          mode: "oneshot",
          knownDeviceIds: () => [Y, X],
          intentGuardWindowMs: liveEnv.guardMs,
          flushStamperState: (s) => s.flush(),
        })
        await sessionY.withWrite(
          stamperYB,
          (target) => uploadData(target, randomBytes(96)),
          { wait: "block" },
        )
        expect(sessionY.currentPartition).toBe(0)
        const ackedYB = stamperYB.getLocalCounter()!
        const probeBucket = ackedYB.findIndex((v) => v > 0)
        expect(probeBucket).toBeGreaterThanOrEqual(0)
        const ackedCounter = ackedYB[probeBucket]
        // Graceful teardown: publishes B's final state and the release
        // sentinel, freeing p0 for X without a TTL wait.
        sessionY.teardown()
        await delay(3_000)

        // ---- device X: acquire p0 under batch A, write, "reload" ----------
        // X's own store is SEPARATE from Y's (a different device) — X has no
        // local state whatsoever for batch B. That is the point.
        const storeX = makeInMemoryCache()
        const makeStamperX = (batch: BatchId) =>
          UtilizationAwareStamper.create(
            liveEnv.signerKeyHex!,
            batch,
            liveEnv.depth,
            storeX,
            keys.owner,
            encryptionKey,
          )
        let cache: PartitionLeaseStateSnapshot | undefined
        const depsX = {
          bee,
          deviceId: X,
          accountId: keys.accountId,
          backupSigner: keys.accountKey,
          swarmEncryptionKey: encryptionKey,
          partitionCount: PARTITION_COUNT,
          mode: "persistent" as const,
          knownDeviceIds: () => [Y, X],
          intentGuardWindowMs: liveEnv.guardMs,
          readLeaseCache: () => cache,
          writeLeaseCache: (snap: PartitionLeaseStateSnapshot | undefined) => {
            if (snap) cache = snap
          },
          flushStamperState: (s: UtilizationAwareStamper) => s.flush(),
        }
        const stamperXA = await makeStamperX(batchA)
        const session1 = new BatchWriteCoordinator({
          ...depsX,
          leaseStamper: stamperXA,
        })
        await session1.withWrite(
          stamperXA,
          (target) => uploadData(target, randomBytes(96)),
          { wait: "block" },
        )
        expect(session1.currentPartition).toBe(0)
        // The acquire-time scan saw Y's released lock; its span must have
        // landed in the persisted snapshot — that is what bounds the adopt's
        // pointer lookup for batch B.
        expect(cache?.priorHolderLeasedUntil).toBeDefined()
        const surviving = cache
        internals(session1).pauseLeaseBackgroundWork()
        cache = surviving

        // ---- X, session 2: default switched to B; adopt -------------------
        const stamperXB = await makeStamperX(batchB)
        const session2 = new BatchWriteCoordinator({
          ...depsX,
          leaseStamper: stamperXB,
        })
        await session2.withWrite(
          stamperXB,
          (target) => uploadData(target, randomBytes(64)),
          { wait: "block" },
        )

        // Adopted the same claim (X's own lease was still live)…
        expect(session2.currentPartition).toBe(0)
        // …and batch B's counter was seeded from Y's published state BEFORE
        // this session's own write bumped some bucket: the prior holder's
        // acked slot is reserved, not re-issued. Zero here is the pre-fix
        // corruption (X had no local B state to bind).
        const resumed = stamperXB.getLocalCounter()!
        expect(resumed[probeBucket]).toBeGreaterThanOrEqual(ackedCounter)

        internals(session2).pauseLeaseBackgroundWork()
      },
    )
  },
)

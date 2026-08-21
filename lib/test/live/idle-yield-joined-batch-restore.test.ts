// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live regression for the idle-yield's restore ledger (PR #537 finding F2).
 *
 * THE BUG (pre-fix): `yieldIdleLease` wrote `writeLeaseCache(undefined)`, so the
 * snapshot's `joinedBatchIds` died with the claim. The next session re-joined
 * nothing, drive X's state pointer stopped being heartbeated, it aged out of
 * `readStatePointer`'s lookup span, and a peer's takeover resumed X from ZERO —
 * re-issuing slots this device had already acked, evicting their chunks.
 *
 * Flow:
 *   1. Session A: acquire on lease batch L, write L, then a TARGETED write to
 *      secondary X (which joins the lease). Both publish their counters.
 *   2. Idle-yield: the persisted snapshot must keep `joinedBatchIds ⊇ {X}` and
 *      carry NO `self` — a yielded lease must cold-acquire, which network-seeds
 *      every restore.
 *   3. Session A2 (fresh coordinator, same cache store): cold acquire, restore
 *      re-joins X from the network, and the next targeted write's slots strictly
 *      advance past what session A acked (never a zero-seed).
 *   4. Device B: after A2 gives the partition up, a takeover resumes X at the
 *      acked counter. B reads through a SECOND node and a plain (non
 *      `UtilizationAwareStamper`) batch context, so `joinBatch` cannot
 *      short-circuit on a locally persisted synced reference — everything here
 *      shares one process, and a real peer would have none.
 *
 * F1 (the streak-clear scoping) gets no live test: it needs the LEASE batch's
 * pointer heartbeat to fail while targeted uploads keep succeeding, which is not
 * orchestratable against a healthy node — it is covered by unit tests.
 *
 * Needs BATCH_ID (L) + BATCH_ID_2 (X) owned by SIGNER_KEY; skips otherwise.
 *
 * Local cluster example:
 *   BEE_URL=http://localhost:1633 PEER_BEE_URL=http://localhost:16331 \
 *   BATCH_ID=<L> BATCH_ID_2=<X> SIGNER_KEY=<queen key> DEPTH=20 \
 *   pnpm exec vitest run --config vitest.live.config.ts \
 *     test/live/idle-yield-joined-batch-restore.test.ts
 */

import { describe, it, expect } from "vitest"
import { randomBytes } from "node:crypto"
import { Bee, BatchId } from "@ethersphere/bee-js"
import { liveEnv, deriveAgentKeys, delay, makeInMemoryCache } from "./env"
import { BatchWriteCoordinator } from "../../src/sync/batch-write-coordinator"
import {
  PartitionLease,
  type PartitionLeaseStateSnapshot,
} from "../../src/sync/partition-lease"
import { deviceHomePartition } from "../../src/sync/partition-lock"
import { UtilizationAwareStamper } from "../../src/utils/batch-utilization"
import { hexToUint8Array } from "../../src/utils/key-derivation"
import { uploadData } from "../../src/proxy/upload"

const BATCH_X_HEX = process.env.BATCH_ID_2
const PEER_URL = process.env.PEER_BEE_URL ?? "http://localhost:16331"
const PARTITION_COUNT = 2
/** Let session A2's detached release land before device B takes over. */
const TAKEOVER_WAIT_MS = 8_000
const TAKEOVER_RETRIES = 5

type Internals = {
  yieldIdleLease: (lease: unknown) => Promise<void>
  partitionLease: unknown
}
const internals = (c: BatchWriteCoordinator) => c as unknown as Internals

/** Σ of a per-bucket counter — an upload's bucket is content-derived, so only
 *  the total is guaranteed to move. */
function counterSum(counter: Uint32Array): number {
  let total = 0
  for (const c of counter) total += c
  return total
}

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

describe.skipIf(!liveEnv.configured || !BATCH_X_HEX)(
  "live — an idle yield keeps the joined-batch restore ledger",
  () => {
    it(
      "restores the secondary after a yield, and a peer resumes it at the acked counter",
      { timeout: 240_000 },
      async () => {
        const bee = new Bee(liveEnv.beeUrl)
        const batchL = new BatchId(liveEnv.batchIdHex!)
        const batchX = new BatchId(BATCH_X_HEX!)
        const keys = await deriveAgentKeys()
        const encryptionKey = hexToUint8Array(keys.encryptionKey)
        const A = deviceHomedAt(0, "yielder")
        const B = deviceHomedAt(0, "taker")

        // One store for device A across both its sessions — this is the
        // "same browser profile" half; the lease cache below is the other.
        const storeA = makeInMemoryCache()
        const makeStamperA = (batch: BatchId) =>
          UtilizationAwareStamper.create(
            liveEnv.signerKeyHex!,
            batch,
            liveEnv.depth,
            storeA,
            keys.owner,
            encryptionKey,
          )

        let cache: PartitionLeaseStateSnapshot | undefined
        const depsA = {
          bee,
          deviceId: A,
          accountId: keys.accountId,
          backupSigner: keys.accountKey,
          swarmEncryptionKey: encryptionKey,
          partitionCount: PARTITION_COUNT,
          mode: "oneshot" as const,
          knownDeviceIds: () => [A, B],
          intentGuardWindowMs: liveEnv.guardMs,
          readLeaseCache: () => cache,
          writeLeaseCache: (snap: PartitionLeaseStateSnapshot | undefined) => {
            cache = snap
          },
          flushStamperState: (s: UtilizationAwareStamper) => s.flush(),
        }

        // ---- session A: hold p0 under L, join + write X -------------------
        const stamperL = await makeStamperA(batchL)
        const stamperX = await makeStamperA(batchX)
        const session1 = new BatchWriteCoordinator({
          ...depsA,
          leaseStamper: stamperL,
          resolveStamperForBatch: async (hex) =>
            hex === batchX.toHex() ? stamperX : undefined,
        })
        await session1.withWrite(
          stamperL,
          (target) => uploadData(target, randomBytes(96)),
          { wait: "block" },
        )
        expect(session1.currentPartition).toBe(0)
        await session1.withWrite(
          stamperX,
          (target) => uploadData(target, randomBytes(96)),
          { wait: "block" },
        )
        // Snapshot, never alias: `getLocalCounter()` hands back the stamper's
        // LIVE array, so a later write would retroactively change these.
        const ackedX = Uint32Array.from(stamperX.getLocalCounter()!)
        const probeBucket = ackedX.findIndex((v) => v > 0)
        expect(probeBucket).toBeGreaterThanOrEqual(0)
        const ackedCounter = ackedX[probeBucket]

        // ---- the idle yield ----------------------------------------------
        await internals(session1).yieldIdleLease(
          internals(session1).partitionLease,
        )
        // The claim is gone (a yielded lease must cold-acquire, which
        // network-seeds every restore) but the ledger survives.
        expect(cache).toBeDefined()
        expect(cache?.self).toBeUndefined()
        expect(cache?.joinedBatchIds).toContain(batchX.toHex())

        // ---- session A2: cold acquire, restore re-joins X ------------------
        const stamperL2 = await makeStamperA(batchL)
        const stamperX2 = await makeStamperA(batchX)
        const session2 = new BatchWriteCoordinator({
          ...depsA,
          leaseStamper: stamperL2,
          resolveStamperForBatch: async (hex) =>
            hex === batchX.toHex() ? stamperX2 : undefined,
        })
        await session2.withWrite(
          stamperL2,
          (target) => uploadData(target, randomBytes(64)),
          { wait: "block" },
        )
        expect(session2.currentPartition).toBe(0)
        await session2.joinedRestoreSettled

        // The restore itself bound X to the partition — no targeted write has
        // run in this session yet. Pre-fix the ledger was gone, so X stayed
        // unjoined and this counter would be `undefined`.
        const restoredLive = stamperX2.getLocalCounter()
        expect(restoredLive).toBeDefined()
        const restoredX = Uint32Array.from(restoredLive!)
        expect(restoredX[probeBucket]).toBeGreaterThanOrEqual(ackedCounter)

        // A targeted write then advances from that resume point.
        await session2.withWrite(
          stamperX2,
          (target) => uploadData(target, randomBytes(64)),
          { wait: "block" },
        )
        const afterA2 = Uint32Array.from(stamperX2.getLocalCounter()!)
        expect(counterSum(afterA2)).toBeGreaterThan(counterSum(restoredX))

        // ---- device B: takeover resumes X at the acked counter -------------
        // Graceful sign-out: publishes every joined batch's final counter and
        // the release sentinel, freeing p0 for B without a TTL wait. The
        // release is detached, so give it a moment to land.
        session2.teardown()
        await delay(TAKEOVER_WAIT_MS)

        // Reads through a SECOND node (the writer masks its own chunks
        // locally) with a plain batch context, so the resume point has to be
        // found on the network or not at all.
        const peerBee = new Bee(PEER_URL)
        const peerLease = await PartitionLease.fromSwarmEncryptionKey({
          bee: peerBee,
          deviceId: B,
          batchId: batchL,
          batchDepth: liveEnv.depth,
          swarmEncryptionKey: encryptionKey,
          stamper: await UtilizationAwareStamper.create(
            liveEnv.signerKeyHex!,
            batchL,
            liveEnv.depth,
            makeInMemoryCache(),
            keys.owner,
            encryptionKey,
          ),
          knownDeviceIds: () => [A, B],
        })
        // Retry until p0 is actually free: A2's release is detached, so its
        // sentinel can still be in flight. Landing anywhere else would read a
        // partition device A never wrote — a meaningless zero that looks
        // exactly like the bug, so refuse to conclude anything from it.
        let claim = await peerLease.acquire({ partitionCount: PARTITION_COUNT })
        for (let i = 0; claim.partition !== 0 && i < TAKEOVER_RETRIES; i++) {
          await delay(TAKEOVER_WAIT_MS)
          claim = await peerLease.acquire({ partitionCount: PARTITION_COUNT })
        }
        expect(claim.partition).toBe(0)

        const peerBatchContext = {
          batchId: batchX,
          depth: liveEnv.depth,
          stamp: () => {
            throw new Error("device B does not stamp in this scenario")
          },
        } as unknown as UtilizationAwareStamper
        // The takeover must land on X's published state, not a zero seed —
        // resuming from zero here re-issues slots device A already acked.
        const resumedByPeer = await peerLease.joinBatch(peerBatchContext)
        expect(counterSum(resumedByPeer)).toBeGreaterThanOrEqual(
          counterSum(afterA2),
        )

        await peerLease.release(resumedByPeer).catch(() => undefined)
      },
    )
  },
)

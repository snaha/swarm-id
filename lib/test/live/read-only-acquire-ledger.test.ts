// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live regression: a READ-ONLY acquire must not drop the lease batch from the
 * joined-batch restore ledger.
 *
 * THE BUG (pre-fix): `persistLeaseSnapshot` merged only `pendingJoinedRestores`
 * into `joinedBatchIds`, while `PartitionLease.serialize()` reports just the
 * batches the session actually SEEDED state for. A read-only acquire (every
 * partition held by a live peer) seeds none — and `seedPendingRestores`
 * deliberately excludes the CURRENT lease batch — so the snapshot came back
 * carrying every secondary but not L itself. L then existed in no future
 * session's restore list, and the next default-stamp change (L → X) left it
 * unrestorable: nothing re-joined it, its state pointer stopped being
 * heartbeated, aged out of `readStatePointer`'s lookup span, and a
 * cross-device takeover would resume L from a ZERO counter.
 * `persistReducedLeaseCache` always merged the lease batch in; this path
 * disagreed with it.
 *
 * Flow:
 *   1. Session A1 (lease batch L): claim p0, write L, then a TARGETED write to
 *      secondary X. Teardown — the ledger is now {L, X}.
 *   2. Two peers claim BOTH partitions, so the account has no free slot.
 *   3. Session A2 (still lease batch L): a `wait: "skip"` write throws
 *      `PartitionContendedError` — a read-only acquire. Its persisted snapshot
 *      must still carry BOTH L and X. Pre-fix, L is silently gone.
 *   4. Peers release. Session A3 rebinds onto X as the lease batch (the
 *      default-stamp change) and the restore must re-join L at its acked
 *      counter, with no targeted write of its own.
 *
 * The sibling ledger scenarios cover the other two persist paths:
 * `idle-yield-joined-batch-restore.test.ts` (yield, plus the peer-takeover leg
 * end-to-end) and `teardown-rebind-joined-restore.test.ts` (rebind).
 *
 * Needs BATCH_ID (L) + BATCH_ID_2 (X) owned by SIGNER_KEY; skips otherwise.
 *
 * Local cluster example:
 *   BEE_URL=http://localhost:1633 BATCH_ID=<L> BATCH_ID_2=<X> \
 *   SIGNER_KEY=<queen key> DEPTH=20 \
 *   pnpm exec vitest run --config vitest.live.config.ts \
 *     test/live/read-only-acquire-ledger.test.ts
 */

import { describe, it, expect } from "vitest"
import { randomBytes } from "node:crypto"
import { Bee, BatchId } from "@ethersphere/bee-js"
import { liveEnv, deriveAgentKeys, delay, makeInMemoryCache } from "./env"
import {
  BatchWriteCoordinator,
  PartitionContendedError,
} from "../../src/sync/batch-write-coordinator"
import type { PartitionLeaseStateSnapshot } from "../../src/sync/partition-lease"
import { deviceHomePartition } from "../../src/sync/partition-lock"
import { UtilizationAwareStamper } from "../../src/utils/batch-utilization"
import { hexToUint8Array } from "../../src/utils/key-derivation"
import { uploadData } from "../../src/proxy/upload"

const BATCH_X_HEX = process.env.BATCH_ID_2
const PARTITION_COUNT = 2
/** Releases are detached (`void this.lock(...)`) and Node has no Web Locks API
 *  to serialize a successor's acquire behind them — so wait them out. */
const RELEASE_SETTLE_MS = 6_000

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
  "live — a read-only acquire keeps the lease batch in the restore ledger",
  () => {
    it(
      "restores the old default after a contended acquire + default-stamp change",
      { timeout: 240_000 },
      async () => {
        const bee = new Bee(liveEnv.beeUrl)
        const batchL = new BatchId(liveEnv.batchIdHex!)
        const batchX = new BatchId(BATCH_X_HEX!)
        const keys = await deriveAgentKeys()
        const encryptionKey = hexToUint8Array(keys.encryptionKey)
        const A = deviceHomedAt(0, "contended")
        const P0 = deviceHomedAt(0, "holder-a")
        const P1 = deviceHomedAt(1, "holder-b")
        const roster = [A, P0, P1]

        // One store for every session of device A — the browser profile
        // survives both the teardown and the default-stamp change.
        const storeA = makeInMemoryCache()
        const stamperFor = (batch: BatchId, store = storeA) =>
          UtilizationAwareStamper.create(
            liveEnv.signerKeyHex!,
            batch,
            liveEnv.depth,
            store,
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
          knownDeviceIds: () => roster,
          intentGuardWindowMs: liveEnv.guardMs,
          readLeaseCache: () => cache,
          writeLeaseCache: (snap: PartitionLeaseStateSnapshot | undefined) => {
            cache = snap
          },
          flushStamperState: (s: UtilizationAwareStamper) => s.flush(),
        }

        // ---- 1. session A1: hold p0 under L, join + write X ---------------
        const stamperL = await stamperFor(batchL)
        const stamperX = await stamperFor(batchX)
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
        const ackedL = Uint32Array.from(stamperL.getLocalCounter()!)
        const probeBucket = ackedL.findIndex((v) => v > 0)
        expect(probeBucket).toBeGreaterThanOrEqual(0)
        const ackedCounter = ackedL[probeBucket]

        session1.teardown()
        expect(cache?.joinedBatchIds).toEqual(
          expect.arrayContaining([batchL.toHex(), batchX.toHex()]),
        )
        await delay(RELEASE_SETTLE_MS)

        // ---- 2. two peers take BOTH partitions ----------------------------
        const peers = await Promise.all(
          [P0, P1].map(async (id) => {
            const stamper = await stamperFor(batchL, makeInMemoryCache())
            return new BatchWriteCoordinator({
              ...depsA,
              deviceId: id,
              leaseStamper: stamper,
              // Peers keep their own (discarded) cache — device A's must not
              // be written by anyone but A.
              readLeaseCache: () => undefined,
              writeLeaseCache: () => {},
              resolveStamperForBatch: undefined,
            })
          }),
        )
        // Sequentially, so the second peer sees the first's claim and settles
        // on the other partition instead of racing it for the same one.
        for (const peer of peers) {
          await peer.withWrite(
            peer.stamperRef,
            (target) => uploadData(target, randomBytes(64)),
            { wait: "block" },
          )
        }
        expect(
          peers.map((p) => p.currentPartition).sort((a, b) => a! - b!),
        ).toEqual([0, 1])

        // ---- 3. session A2: the contended (read-only) acquire --------------
        const stamperL2 = await stamperFor(batchL)
        const session2 = new BatchWriteCoordinator({
          ...depsA,
          leaseStamper: stamperL2,
          resolveStamperForBatch: async (hex) =>
            hex === batchX.toHex() ? stamperX : undefined,
        })
        await expect(
          session2.withWrite(
            stamperL2,
            (target) => uploadData(target, randomBytes(32)),
            { wait: "skip" },
          ),
        ).rejects.toBeInstanceOf(PartitionContendedError)
        expect(session2.currentPartition).toBeUndefined()

        // THE REGRESSION: the read-only acquire seeded no batch state, so
        // `serialize()` reported nothing and only the pending secondaries were
        // merged — dropping L, the very batch this session is bound to.
        expect(cache?.joinedBatchIds).toContain(batchX.toHex())
        expect(cache?.joinedBatchIds).toContain(batchL.toHex())

        // ---- 4. peers leave; A rebinds onto X as its new default ----------
        for (const peer of peers) peer.teardown()
        await delay(RELEASE_SETTLE_MS)

        const stamperL3 = await stamperFor(batchL)
        const stamperX3 = await stamperFor(batchX)
        const session3 = new BatchWriteCoordinator({
          ...depsA,
          leaseStamper: stamperX3, // the default-stamp change: L -> X
          resolveStamperForBatch: async (hex) =>
            hex === batchL.toHex() ? stamperL3 : undefined,
        })
        await session3.withWrite(
          stamperX3,
          (target) => uploadData(target, randomBytes(64)),
          { wait: "block" },
        )
        expect(session3.currentPartition).toBe(0)
        await session3.joinedRestoreSettled

        // The restore alone re-joined L — no targeted write to it in this
        // session. Pre-fix the contended acquire had erased L from the ledger,
        // so nothing re-joins it and this counter is `undefined`.
        const restoredLive = stamperL3.getLocalCounter()
        expect(restoredLive).toBeDefined()
        expect(
          Uint32Array.from(restoredLive!)[probeBucket],
        ).toBeGreaterThanOrEqual(ackedCounter)

        session3.teardown()
      },
    )
  },
)

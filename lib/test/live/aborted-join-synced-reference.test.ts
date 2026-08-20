// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live regression: a join that seeds a batch but ABORTS before the caller binds
 * the counter must leave no synced reference behind.
 *
 * THE BUG (pre-fix): `seedBatchState` persisted the synced reference inline
 * (`stamper.setSyncedReference` — a direct IndexedDB metadata write, not gated
 * on a flush), while the counter it returns only reaches the stamper when the
 * CALLER later runs `bindPartition`. Every `joinBatch` caller re-checks the
 * lease in between and can abort — `ensureBatchJoined` throws
 * `PartitionLeaseLostError`, the cross-batch adopt and the network restore
 * `return` on a bumped epoch. The reference then outlives the counter it
 * describes, breaking `seedBatchState`'s own KEYSTONE ("the stamper keeps its
 * local per-partition counter monotonic and >= its synced-reference counter").
 *
 * Why that corrupts: the next read passes the stale reference as
 * `knownReference`, `readPartitionState` matches it against the live pointer and
 * short-circuits to `{ unchanged: true }` WITHOUT downloading a counter chunk,
 * and `seedBatchState`'s `unchanged` branch then seeds from
 * `buildLeaseLocalCounter()` — ZERO for a batch this device has never written.
 * The device binds zero over a prior holder's resume point and re-issues its
 * acked slots. `writePartitionState`'s monotonicity tripwire cannot catch it:
 * it compares against this session's own `previousCounter`, which is also zero.
 *
 * Flow:
 *   1. Device Y: hold p0, write batch X three times, teardown (publishes X's
 *      state + the release sentinel).
 *   2. Device Z (a SEPARATE store — no local state for X whatsoever): acquire
 *      p0 under lease batch L, then a targeted write to X whose join is
 *      aborted by a displacement signalled before it runs.
 *   3. Z "reloads" with its default switched to X (the cross-batch adopt). X's
 *      counter must resume at Y's published value, not zero.
 *
 * Needs BATCH_ID (L) + BATCH_ID_2 (X) owned by SIGNER_KEY; skips otherwise.
 *
 * Local cluster example:
 *   BEE_URL=http://localhost:1633 BATCH_ID=<L> BATCH_ID_2=<X> \
 *   SIGNER_KEY=<queen key> DEPTH=20 \
 *   pnpm exec vitest run --config vitest.live.config.ts \
 *     test/live/aborted-join-synced-reference.test.ts
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

const BATCH_X_HEX = process.env.BATCH_ID_2
const PARTITION_COUNT = 2
/** Device Y's teardown release is detached; let it land before Z acquires. */
const RELEASE_SETTLE_MS = 6_000
/** Uploads device Y acks to X, so its counter sum clears the single bump a
 *  zero-seeded session 2 could produce on its own. */
const PRIOR_HOLDER_WRITES = 3

type Internals = { signalLeaseLost: () => void }
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
  "live — an aborted join leaves no synced reference behind",
  () => {
    it(
      "never zero-seeds a batch whose join was aborted before the bind",
      { timeout: 240_000 },
      async () => {
        const bee = new Bee(liveEnv.beeUrl)
        const batchL = new BatchId(liveEnv.batchIdHex!)
        const batchX = new BatchId(BATCH_X_HEX!)
        const keys = await deriveAgentKeys()
        const encryptionKey = hexToUint8Array(keys.encryptionKey)
        // Both home at p0 so Y's released claim is exactly the one Z takes.
        const Y = deviceHomedAt(0, "prior")
        const Z = deviceHomedAt(0, "aborter")

        const makeStamper = (
          batch: BatchId,
          store: ReturnType<typeof makeInMemoryCache>,
        ) =>
          UtilizationAwareStamper.create(
            liveEnv.signerKeyHex!,
            batch,
            liveEnv.depth,
            store,
            keys.owner,
            encryptionKey,
          )

        // ---- device Y: publish a real resume point for batch X ------------
        const storeY = makeInMemoryCache()
        const stamperYX = await makeStamper(batchX, storeY)
        const sessionY = new BatchWriteCoordinator({
          bee,
          leaseStamper: stamperYX,
          deviceId: Y,
          accountId: keys.accountId,
          backupSigner: keys.accountKey,
          swarmEncryptionKey: encryptionKey,
          partitionCount: PARTITION_COUNT,
          mode: "oneshot",
          knownDeviceIds: () => [Y, Z],
          intentGuardWindowMs: liveEnv.guardMs,
          flushStamperState: (s) => s.flush(),
        })
        for (let i = 0; i < PRIOR_HOLDER_WRITES; i++) {
          await sessionY.withWrite(
            stamperYX,
            (target) => uploadData(target, randomBytes(96)),
            { wait: "block" },
          )
        }
        expect(sessionY.currentPartition).toBe(0)
        const ackedX = Uint32Array.from(stamperYX.getLocalCounter()!)
        expect(counterSum(ackedX)).toBeGreaterThanOrEqual(PRIOR_HOLDER_WRITES)
        sessionY.teardown()
        await delay(RELEASE_SETTLE_MS)

        // ---- device Z: acquire p0 under L, then abort a join of X ---------
        // Z's store is its own — it has NO local state for batch X. That is
        // what makes a zero seed corruption rather than a stale-but-ours read.
        const storeZ = makeInMemoryCache()
        let cache: PartitionLeaseStateSnapshot | undefined
        const depsZ = {
          bee,
          deviceId: Z,
          accountId: keys.accountId,
          backupSigner: keys.accountKey,
          swarmEncryptionKey: encryptionKey,
          partitionCount: PARTITION_COUNT,
          mode: "persistent" as const,
          knownDeviceIds: () => [Y, Z],
          intentGuardWindowMs: liveEnv.guardMs,
          readLeaseCache: () => cache,
          writeLeaseCache: (snap: PartitionLeaseStateSnapshot | undefined) => {
            if (snap) cache = snap
          },
          flushStamperState: (s: UtilizationAwareStamper) => s.flush(),
        }
        const stamperZL = await makeStamper(batchL, storeZ)
        const stamperZX = await makeStamper(batchX, storeZ)
        const session1 = new BatchWriteCoordinator({
          ...depsZ,
          leaseStamper: stamperZL,
        })
        await session1.withWrite(
          stamperZL,
          (target) => uploadData(target, randomBytes(96)),
          { wait: "block" },
        )
        expect(session1.currentPartition).toBe(0)

        // A displacement signalled before the targeted write: `withWrite`
        // still runs `ensureBatchJoined` → `joinBatch` (which seeds X), then
        // re-checks and aborts instead of binding. This is the real abort
        // path, not a simulation of one.
        internals(session1).signalLeaseLost()
        await expect(
          session1.withWrite(
            stamperZX,
            (target) => uploadData(target, randomBytes(96)),
            { wait: "block" },
          ),
        ).rejects.toThrow()

        // The invariant, stated directly: nothing bound X's counter, so
        // nothing may claim X's counter is in sync with a published state.
        expect(await stamperZX.getSyncedReference(0)).toBeUndefined()

        // ---- Z, session 2: default switched to X; adopt -------------------
        // The cross-batch adopt re-seeds X from the network. Pre-fix the stale
        // reference made `readPartitionState` short-circuit to `unchanged`,
        // and X bound this device's ZERO counter over Y's resume point.
        const stamperZX2 = await makeStamper(batchX, storeZ)
        const session2 = new BatchWriteCoordinator({
          ...depsZ,
          leaseStamper: stamperZX2,
        })
        await session2.withWrite(
          stamperZX2,
          (target) => uploadData(target, randomBytes(64)),
          { wait: "block" },
        )
        expect(session2.currentPartition).toBe(0)

        // Y's acked slots are reserved, not re-issued: the resumed counter is
        // Y's plus this session's own write. A zero seed would leave the sum
        // at just this session's single bump.
        const resumed = Uint32Array.from(stamperZX2.getLocalCounter()!)
        expect(counterSum(resumed)).toBeGreaterThan(counterSum(ackedX))

        session2.teardown()
      },
    )
  },
)

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live regression: a `teardown()` that is a REBIND, not a sign-out, must keep
 * the joined-batch restore ledger.
 *
 * THE BUG (pre-fix): `teardown()` ends with `writeLeaseCache(undefined)`, an
 * exemption `persistReducedLeaseCache` justifies with "it is the sign-out
 * path". It is not only that — `SwarmIdProxy.initializeStamper` tears the
 * coordinator down and builds its successor for the SAME account in the very
 * next statement, on every rebind (Bee-node change, default-stamp change,
 * stamp dilution), and `clearDefaultBinding` does the same. The successor then
 * reads no cache, so `seedPendingRestores` gets nothing and secondary batch X
 * is never re-joined: `heartbeatStatePointer` no-ops for a batch whose
 * `lastReferenceHex` is unset, X's state pointer ages out of
 * `readStatePointer`'s lookup span, and a later cross-device takeover resumes
 * X from a ZERO counter — re-issuing slots this device already acked and
 * evicting their chunks.
 *
 * Flow:
 *   1. Session A: acquire p0 on lease batch L, write L, then a TARGETED write
 *      to secondary X (which joins the lease session).
 *   2. Teardown, exactly as a rebind performs it. The persisted snapshot must
 *      keep `joinedBatchIds ⊇ {X}` and carry NO `self` — the successor has to
 *      cold-acquire, which network-seeds every restore.
 *   3. Session A2 (fresh coordinator, same store + cache — the rebind): cold
 *      acquire, and the restore re-joins X from the network with NO targeted
 *      write of its own. Pre-fix X stays unjoined and its counter `undefined`.
 *
 * The sibling `idle-yield-joined-batch-restore.test.ts` covers the same ledger
 * through the yield path (and carries the peer-takeover leg end-to-end); this
 * one pins the teardown door it left open.
 *
 * Needs BATCH_ID (L) + BATCH_ID_2 (X) owned by SIGNER_KEY; skips otherwise.
 *
 * Local cluster example:
 *   BEE_URL=http://localhost:1633 BATCH_ID=<L> BATCH_ID_2=<X> \
 *   SIGNER_KEY=<queen key> DEPTH=20 \
 *   pnpm exec vitest run --config vitest.live.config.ts \
 *     test/live/teardown-rebind-joined-restore.test.ts
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
/** Teardown's release is detached (`void this.lock(...)`), and Node has no Web
 *  Locks API to serialize the successor's acquire behind it — so wait. */
const RELEASE_SETTLE_MS = 6_000

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
  "live — a teardown-driven rebind keeps the joined-batch restore ledger",
  () => {
    it(
      "restores the secondary in the successor session, with no targeted write",
      { timeout: 240_000 },
      async () => {
        const bee = new Bee(liveEnv.beeUrl)
        const batchL = new BatchId(liveEnv.batchIdHex!)
        const batchX = new BatchId(BATCH_X_HEX!)
        const keys = await deriveAgentKeys()
        const encryptionKey = hexToUint8Array(keys.encryptionKey)
        const A = deviceHomedAt(0, "rebinder")
        const PEER = deviceHomedAt(0, "peer")

        // One store across both sessions — the rebind keeps the browser
        // profile; only the coordinator instance is replaced.
        const storeA = makeInMemoryCache()
        const makeStamper = (batch: BatchId) =>
          UtilizationAwareStamper.create(
            liveEnv.signerKeyHex!,
            batch,
            liveEnv.depth,
            storeA,
            keys.owner,
            encryptionKey,
          )

        let cache: PartitionLeaseStateSnapshot | undefined
        const deps = {
          bee,
          deviceId: A,
          accountId: keys.accountId,
          backupSigner: keys.accountKey,
          swarmEncryptionKey: encryptionKey,
          partitionCount: PARTITION_COUNT,
          mode: "oneshot" as const,
          knownDeviceIds: () => [A, PEER],
          intentGuardWindowMs: liveEnv.guardMs,
          readLeaseCache: () => cache,
          writeLeaseCache: (snap: PartitionLeaseStateSnapshot | undefined) => {
            cache = snap
          },
          flushStamperState: (s: UtilizationAwareStamper) => s.flush(),
        }

        // ---- session A: hold p0 under L, join + write X -------------------
        const stamperL = await makeStamper(batchL)
        const stamperX = await makeStamper(batchX)
        const session1 = new BatchWriteCoordinator({
          ...deps,
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

        // ---- the rebind's teardown ----------------------------------------
        session1.teardown()
        // The claim must not survive (the successor cold-acquires, which
        // network-seeds every restore) but the ledger must.
        expect(cache).toBeDefined()
        expect(cache?.self).toBeUndefined()
        expect(cache?.joinedBatchIds).toContain(batchX.toHex())
        await delay(RELEASE_SETTLE_MS)

        // ---- session A2: the successor coordinator -------------------------
        const stamperL2 = await makeStamper(batchL)
        const stamperX2 = await makeStamper(batchX)
        const session2 = new BatchWriteCoordinator({
          ...deps,
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

        // The restore alone bound X — no targeted write has run in this
        // session. Pre-fix the ledger died with the teardown, X stayed
        // unjoined, and this counter is `undefined`.
        const restoredLive = stamperX2.getLocalCounter()
        expect(restoredLive).toBeDefined()
        const restoredX = Uint32Array.from(restoredLive!)
        expect(restoredX[probeBucket]).toBeGreaterThanOrEqual(ackedCounter)

        // The resume point is real: a targeted write advances past it.
        await session2.withWrite(
          stamperX2,
          (target) => uploadData(target, randomBytes(64)),
          { wait: "block" },
        )
        expect(
          counterSum(Uint32Array.from(stamperX2.getLocalCounter()!)),
        ).toBeGreaterThan(counterSum(restoredX))

        session2.teardown()
      },
    )
  },
)

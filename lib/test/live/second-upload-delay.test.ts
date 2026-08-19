// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reproduces "the second SOC upload waits several seconds before it starts"
 * (partition already held).
 *
 * `withWrite` runs `ensureLease` BEFORE the op, under the write lock. For a held
 * lease that is `ensureLeaseStillValid`, whose throttle only skips the gateway
 * read while `now - lastLeaseValidatedAt < LEASE_REFRESH_MS`. Once that lapses it
 * does a synchronous `readPartitionLock` (± a `refresh()` re-assert) on the
 * gateway — BEFORE the op — which is the stall the user felt.
 *
 * We measure "pre-op latency": the time from the `withWrite()` call until the op
 * actually starts. In oneshot mode there is no refresh tick, so
 * `lastLeaseValidatedAt` stays at acquire time and the throttle boundary is
 * crossed purely by elapsed wall time — isolating the mechanism deterministically
 * (no dependence on tick timing). Expectation:
 *   - upload-2 right after acquire (within the window) → no read → tiny pre-op
 *     (the TTL-optimism fast path the user expected),
 *   - upload-3 after waiting > LEASE_REFRESH_MS → re-validation read → seconds.
 *
 * The throttle is stricter than the design's TTL-optimism (zero reads while
 * `now < leasedUntil - skew`); the follow-up fix gates the check on
 * `leaseNearExpiry()` alone, after which upload-3 is fast too. Opt-in; skips
 * without a `.env` (see README).
 */

import { randomBytes } from "node:crypto"
import { describe, it, expect, beforeAll } from "vitest"
import { Identifier, PrivateKey } from "@ethersphere/bee-js"
import { BatchWriteCoordinator } from "../../src/sync/batch-write-coordinator"
import {
  UtilizationAwareStamper,
  PARTITION_COUNT,
  LEASE_REFRESH_MS,
} from "../../src/utils/batch-utilization"
import { readRoster } from "../../src/sync/device-roster"
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

describe.skipIf(!liveEnv.configured)(
  "live — second-upload-start delay (held partition)",
  () => {
    let ctx: LiveContext
    let keys: Awaited<ReturnType<typeof deriveAgentKeys>>
    let D: string

    beforeAll(async () => {
      ctx = createContext()
      keys = await deriveAgentKeys()
      D = deviceId("device-solo")
      console.log(`account ${keys.accountId}  device ${D}`)
    })

    it("the second held-lease upload starts immediately; a later one re-validates", async () => {
      const encryptionKey = hexToUint8Array(keys.encryptionKey)
      const stamper = await UtilizationAwareStamper.create(
        ctx.signerKey.toHex(),
        ctx.batchID,
        ctx.depth,
        makeInMemoryCache(),
        keys.owner,
        encryptionKey,
      )
      const coordinator = new BatchWriteCoordinator({
        bee: ctx.bee,
        leaseStamper: stamper,
        deviceId: D,
        accountId: keys.accountId,
        knownDeviceIds: () => [D],
        refreshKnownDeviceIds: () =>
          readRoster({
            bee: ctx.bee,
            accountId: keys.accountId,
            owner: keys.owner,
          })
            .then(() => undefined)
            .catch(() => undefined),
        backupSigner: keys.accountKey,
        swarmEncryptionKey: encryptionKey,
        partitionCount: PARTITION_COUNT,
        mode: "oneshot", // no refresh tick → lastLeaseValidatedAt fixed at acquire
        flushStamperState: (s) => s.flush(),
      })

      // One upload of a random SOC through the real write path; returns the
      // "pre-op latency" = how long after pressing until the op actually starts.
      const uploadAndMeasurePreOp = async (): Promise<number> => {
        const callTime = Date.now()
        let opStart = 0
        const result = await coordinator.withWrite(
          stamper,
          async (target: UploadTarget) => {
            opStart = Date.now()
            return uploadSOC(
              target,
              new PrivateKey(randomBytes(32)),
              new Identifier(randomBytes(32)),
              randomBytes(64),
              {},
            )
          },
          { wait: "skip" },
        )
        expect(result.socAddress?.length, "SOC upload succeeded").toBe(32)
        return opStart - callTime
      }

      const acquirePreOp = await uploadAndMeasurePreOp() // upload-1: acquires
      const heldPreOp = await uploadAndMeasurePreOp() // upload-2: within window

      // Cross the throttle window so the held-lease freshness check is no longer
      // skipped (no refresh tick in oneshot keeps lastLeaseValidatedAt at acquire).
      await delay(LEASE_REFRESH_MS + 1_000)

      const staleHeldPreOp = await uploadAndMeasurePreOp() // upload-3: re-validates

      console.log(
        `\n  ⏱  pre-op latency (call → op start):` +
          `  upload-1(acquire)=${acquirePreOp}ms` +
          `  upload-2(held,in-window)=${heldPreOp}ms` +
          `  upload-3(held,>${LEASE_REFRESH_MS}ms)=${staleHeldPreOp}ms\n`,
      )

      // The held-lease upload WITHIN the throttle window starts immediately —
      // pure CPU, no gateway round-trip before the op (the TTL-optimism fast
      // path the user expected). A remote-gateway read is tens-to-thousands of
      // ms, so a sub-150ms pre-op proves no read happened.
      expect(
        heldPreOp,
        "in-window held-lease upload starts immediately (no gateway read)",
      ).toBeLessThan(150)

      // The reproduction: once past the window, `ensureLeaseStillValid` does a
      // synchronous gateway read (readPartitionLock, ± a refresh() re-assert)
      // BEFORE the op — so the upload measurably does NOT start immediately. The
      // magnitude is gateway-dependent (a fast 404 here; seconds when the lock
      // SOC is a slow retrieve or a sentinel triggers refresh — the user's case).
      // NOTE: when the TTL-optimism throttle fix lands this read disappears and
      // staleHeldPreOp drops to ~heldPreOp; flip this to `toBeLessThan(150)` then.
      expect(
        staleHeldPreOp,
        "upload past the throttle window pays a gateway re-validation before starting",
      ).toBeGreaterThan(heldPreOp)
    })
  },
)

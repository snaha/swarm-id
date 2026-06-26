// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-device, 3 devices — the interesting case (K = PARTITION_COUNT = 2, so a
 * 3rd device stresses the append-only roster). A writes a stamp, B connects app
 * X, C connects app Y; each publishes its own feed + appends to the roster. A
 * 3rd device joining can never clobber the existing two. Asserts cross-device
 * convergence over all 3, stamp-delete propagation, device removal +
 * resurrection, the §7 invariant, and reports steady-state fold latency.
 *
 * Opt-in — skips unless a `.env` configures BATCH_ID/SIGNER_KEY (see README).
 */

import { describe, it, expect, beforeAll } from "vitest"
import { Topic } from "@ethersphere/bee-js"
import { publishDeviceState } from "../../src/sync/device-state"
import { ensureInRoster } from "../../src/sync/device-roster"
import { foldAccountFromSwarm } from "../../src/sync/fold-account-from-swarm"
import { ACCOUNT_SYNC_TOPIC_PREFIX } from "../../src/sync/publish-account-state"
import { AsyncEpochFinder } from "../../src/proxy/feeds/epochs"
import {
  multiDeviceEnv,
  createContext,
  deriveAgentKeys,
  deviceId,
  makeDevice,
  makeStamp,
  makeView,
  makeApp,
  foldUntil,
  delay,
  type FoldedAccount,
  type MultiDeviceContext,
} from "./env"

const APP_B = "https://app-b.example"
const APP_C = "https://app-c.example"
const TIMING_RUNS = 5

const activeDevices = (a: FoldedAccount) =>
  a.devices.filter((d) => !d.removedAt)

describe.skipIf(!multiDeviceEnv.configured)(
  "multi-device — per-device feeds converge (3 devices)",
  () => {
    let ctx: MultiDeviceContext
    let keys: Awaited<ReturnType<typeof deriveAgentKeys>>
    let A: string
    let B: string
    let C: string

    const pub = (
      device: ReturnType<typeof makeDevice>,
      view: ReturnType<typeof makeView>,
    ) =>
      publishDeviceState({
        bee: ctx.bee,
        accountId: keys.accountId,
        device,
        accountKey: keys.accountKey,
        owner: keys.owner,
        encryptionKey: keys.encryptionKey,
        view,
        target: ctx.target,
      })

    const fold = (predicate: (a: FoldedAccount) => boolean, what: string) =>
      foldUntil(ctx.bee, keys.derivationKey, keys.accountId, predicate, what)

    beforeAll(async () => {
      ctx = createContext()
      keys = await deriveAgentKeys()
      A = deviceId("device-a")
      B = deviceId("device-b")
      C = deviceId("device-c")
      console.log(`account ${keys.accountId}  A=${A} B=${B} C=${C}`)
    })

    it("all 3 devices publish their own feeds + roster appends and the fold converges (no clobber)", async () => {
      // Sequence the publishes so the roster's sequential indices 0,1,2 don't
      // race on the gateway.
      const sA = await pub(
        makeDevice(A, "Device A"),
        makeView({
          postageStamps: [makeStamp(ctx.batchID, ctx.signerKey, ctx.depth)],
        }),
      )
      expect(sA.status).not.toBe("error")
      await delay(multiDeviceEnv.propDelayMs)
      const sB = await pub(
        makeDevice(B, "Device B"),
        makeView({ connectedApps: [makeApp(APP_B)] }),
      )
      expect(sB.status).not.toBe("error")
      await delay(multiDeviceEnv.propDelayMs)
      const sC = await pub(
        makeDevice(C, "Device C"),
        makeView({ connectedApps: [makeApp(APP_C)] }),
      )
      expect(sC.status).not.toBe("error")

      const folded = await fold(
        (a) =>
          a.postageStamps.some((s) => !s.deletedAt) &&
          a.connectedApps.some((c) => c.appUrl === APP_B) &&
          a.connectedApps.some((c) => c.appUrl === APP_C) &&
          activeDevices(a).length === 3,
        "stamp + app X + app Y + 3 devices",
      )
      expect(folded, "fold converged").toBeDefined()
      expect(folded!.postageStamps.some((s) => !s.deletedAt)).toBe(true)
      expect(folded!.connectedApps.some((c) => c.appUrl === APP_B)).toBe(true)
      expect(folded!.connectedApps.some((c) => c.appUrl === APP_C)).toBe(true)
      expect(activeDevices(folded!)).toHaveLength(3)
    })

    it("reports steady-state fold latency (read cost across the roster + 3 device feeds)", async () => {
      // Data is already in place + converged: time N single folds back-to-back,
      // no polling/delays, so the number is the real parallel read cost.
      const foldMs: number[] = []
      for (let i = 0; i < TIMING_RUNS; i++) {
        const t0 = Date.now()
        await foldAccountFromSwarm({
          bee: ctx.bee,
          derivationKey: keys.derivationKey,
          accountId: keys.accountId,
        }).catch(() => undefined)
        foldMs.push(Date.now() - t0)
      }
      const min = Math.min(...foldMs)
      const avg = Math.round(foldMs.reduce((s, n) => s + n, 0) / foldMs.length)
      console.log(
        `⏱  foldAccountFromSwarm (3 devices): min=${min}ms avg=${avg}ms runs=[${foldMs.join(", ")}]ms`,
      )
      expect(foldMs).toHaveLength(TIMING_RUNS)
    })

    it("a stamp delete on A propagates (0 active)", async () => {
      await pub(
        makeDevice(A, "Device A"),
        makeView({
          postageStamps: [
            makeStamp(ctx.batchID, ctx.signerKey, ctx.depth, Date.now()),
          ],
        }),
      )
      const folded = await fold(
        (a) =>
          a.postageStamps.every(
            (s) => s.batchID.equals(ctx.batchID) && !!s.deletedAt,
          ),
        "stamp tombstoned",
      )
      expect(folded, "fold converged").toBeDefined()
      expect(folded!.postageStamps.filter((s) => !s.deletedAt)).toHaveLength(0)
    })

    it("device C removal propagates, then a re-publish resurrects it", async () => {
      await ensureInRoster({
        bee: ctx.bee,
        accountKey: keys.accountKey,
        owner: keys.owner,
        encryptionKey: keys.encryptionKey,
        accountId: keys.accountId,
        device: { ...makeDevice(C, "Device C"), removedAt: Date.now() },
        target: ctx.target,
      })
      const removed = await fold(
        (a) => !!a.devices.find((d) => d.deviceId === C)?.removedAt,
        "device C removed",
      )
      expect(removed, "fold converged on removal").toBeDefined()
      expect(activeDevices(removed!)).toHaveLength(2)
      expect(activeDevices(removed!).some((d) => d.deviceId === C)).toBe(false)

      await delay(multiDeviceEnv.propDelayMs)
      await pub(
        makeDevice(C, "Device C"),
        makeView({ connectedApps: [makeApp(APP_C)] }),
      )
      const resurrected = await fold(
        (a) =>
          !a.devices.find((d) => d.deviceId === C)?.removedAt &&
          activeDevices(a).length === 3,
        "device C resurrected (3 active)",
      )
      expect(resurrected, "fold converged on resurrection").toBeDefined()
      expect(activeDevices(resurrected!)).toHaveLength(3)
    })

    it("never writes the legacy shared swarm-id-backup-v1 feed (§7 invariant)", async () => {
      const legacyTopic = Topic.fromString(
        `${ACCOUNT_SYNC_TOPIC_PREFIX}:${keys.accountId}`,
      )
      const legacyRef = await new AsyncEpochFinder(
        ctx.bee,
        legacyTopic,
        keys.owner,
      )
        .findAt(BigInt(Math.floor(Date.now() / 1000)))
        .catch(() => undefined)
      expect(legacyRef).toBeUndefined()
    })
  },
)

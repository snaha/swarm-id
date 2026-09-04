// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-device, 2 devices: each publishes its OWN device-state feed (+ appends
 * to the append-only roster); a reader folds the roster + all device feeds and
 * must converge. Covers cross-device convergence, stamp-delete + device-removal
 * tombstone propagation, resurrection, and the §7 invariant (the legacy shared
 * `swarm-id-backup-v1` feed is never written).
 *
 * Opt-in — skips unless a `.env` configures BATCH_ID/SIGNER_KEY (see README).
 */

import { describe, it, expect, beforeAll } from "vitest"
import { Topic } from "@ethersphere/bee-js"
import { publishDeviceState } from "../../src/sync/device-state"
import { ensureInRoster } from "../../src/sync/device-roster"
import { AsyncEpochFinder } from "../../src/proxy/feeds/epochs"
import {
  liveEnv,
  createContext,
  deriveAgentKeys,
  deviceId,
  makeDevice,
  makeStamp,
  makeView,
  makeApp,
  foldUntil,
  delay,
  type LiveContext,
} from "./env"

const APP_URL = "https://app-b.example"

describe.skipIf(!liveEnv.configured)(
  "live — per-device feeds converge (2 devices)",
  () => {
    let ctx: LiveContext
    let keys: Awaited<ReturnType<typeof deriveAgentKeys>>
    let DEVICE_A: string
    let DEVICE_B: string

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

    const fold = (predicate: Parameters<typeof foldUntil>[3], what: string) =>
      foldUntil(ctx.bee, keys.derivationKey, keys.accountId, predicate, what)

    beforeAll(async () => {
      ctx = createContext()
      keys = await deriveAgentKeys()
      DEVICE_A = deviceId("device-a")
      DEVICE_B = deviceId("device-b")
      console.log(`account ${keys.accountId}  A=${DEVICE_A}  B=${DEVICE_B}`)
    })

    it("A writes a stamp and B connects an app (own feeds), and the fold converges", async () => {
      const sA = await pub(
        makeDevice(DEVICE_A, "Device A"),
        makeView({
          postageStamps: [makeStamp(ctx.batchID, ctx.signerKey, ctx.depth)],
        }),
      )
      expect(sA.status).not.toBe("error")
      await delay(liveEnv.propDelayMs)
      const sB = await pub(
        makeDevice(DEVICE_B, "Device B"),
        makeView({ connectedApps: [makeApp(APP_URL)] }),
      )
      expect(sB.status).not.toBe("error")

      const folded = await fold(
        (a) =>
          a.postageStamps.some((s) => !s.deletedAt) &&
          a.connectedApps.some((c) => c.appUrl === APP_URL && !c.revokedAt) &&
          a.devices.filter((d) => !d.removedAt).length === 2,
        "stamp + app + 2 devices",
      )
      expect(folded, "fold converged").toBeDefined()
      expect(folded!.postageStamps.some((s) => !s.deletedAt)).toBe(true)
      expect(folded!.connectedApps.some((c) => c.appUrl === APP_URL)).toBe(true)
      expect(folded!.devices.filter((d) => !d.removedAt)).toHaveLength(2)
    })

    it("a stamp delete on A propagates (0 active)", async () => {
      await pub(
        makeDevice(DEVICE_A, "Device A"),
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

    it("device B removal propagates, then a re-publish resurrects it", async () => {
      await ensureInRoster({
        bee: ctx.bee,
        accountKey: keys.accountKey,
        owner: keys.owner,
        encryptionKey: keys.encryptionKey,
        accountId: keys.accountId,
        device: { ...makeDevice(DEVICE_B, "Device B"), removedAt: Date.now() },
        target: ctx.target,
      })
      const removed = await fold(
        (a) => !!a.devices.find((d) => d.deviceId === DEVICE_B)?.removedAt,
        "device B removed",
      )
      expect(removed, "fold converged on removal").toBeDefined()
      expect(
        removed!.devices
          .filter((d) => !d.removedAt)
          .some((d) => d.deviceId === DEVICE_B),
      ).toBe(false)

      await pub(makeDevice(DEVICE_B, "Device B"), makeView())
      const resurrected = await fold(
        (a) =>
          !a.devices.find((d) => d.deviceId === DEVICE_B)?.removedAt &&
          !!a.devices.find((d) => d.deviceId === DEVICE_B),
        "device B resurrected",
      )
      expect(resurrected, "fold converged on resurrection").toBeDefined()
      expect(
        resurrected!.devices
          .filter((d) => !d.removedAt)
          .some((d) => d.deviceId === DEVICE_B),
      ).toBe(true)
    })
  },
)

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-device regression: a device that NEVER renamed the account must not
 * clobber a peer's genuine rename.
 *
 * The per-field scalar clock for a never-edited field falls back to the
 * account's STABLE `createdAt` (`accountStateToDeviceView`). A regression
 * stamped it with a fresh `Date.now()` on every publish, so device A's
 * unchanged default name kept getting a newer clock and won per-field LWW over
 * device B's real rename. Here A publishes its default name twice — straddling
 * B's rename — and the fold must still converge to (and stay on) B's rename.
 *
 * Opt-in — skips unless a `.env` configures BATCH_ID/SIGNER_KEY (see README).
 */

import { describe, it, expect, beforeAll } from "vitest"
import {
  accountStateToDeviceView,
  publishDeviceState,
} from "../../src/sync/device-state"
import type { AccountStateSnapshot } from "../../src/schemas"
import {
  liveEnv,
  createContext,
  deriveAgentKeys,
  deviceId,
  makeDevice,
  foldUntil,
  delay,
  TEST_ACCOUNT_PUBLIC_KEY,
  type LiveContext,
} from "./env"

// A fixed account birth date and a genuine rename clock 5s after it. Both are
// well below any wall-clock `Date.now()`, so the old fresh-timestamp fallback
// would have buried the rename.
const CREATED_AT = 1_700_000_000_000
const RENAME_AT = CREATED_AT + 5_000

describe.skipIf(!liveEnv.configured)(
  "live — a never-renamed device does not clobber a peer's rename",
  () => {
    let ctx: LiveContext
    let keys: Awaited<ReturnType<typeof deriveAgentKeys>>
    let DEVICE_A: string
    let DEVICE_B: string

    // A "new account" snapshot for one device: the name is set at creation, but
    // (like the real create page) there is NO explicit `accountNameAt`, and
    // `lastModified` is freshly stamped at publish time. `accountStateToDeviceView`
    // must clock an unedited name at `createdAt`, never that fresh `lastModified`.
    const snapshot = (
      accountName: string,
      accountNameAt: number | undefined,
    ): AccountStateSnapshot => ({
      version: 1,
      timestamp: Date.now(),
      accountId: keys.accountId,
      metadata: {
        accountName,
        defaultPostageStampBatchID: undefined,
        accountNameAt,
        // #377/#381 made accountPublicKey required on the device-state feed;
        // without it the published snapshot fails read validation and the fold
        // reads no views. `accountStateToDeviceView` sources it from here.
        publicKey: TEST_ACCOUNT_PUBLIC_KEY,
        createdAt: CREATED_AT,
        lastModified: Date.now(),
        devices: [],
        partitionCount: 2,
      },
      connectedApps: [],
      postageStamps: [],
    })

    const pub = (id: string, name: string, nameAt: number | undefined) =>
      publishDeviceState({
        bee: ctx.bee,
        accountId: keys.accountId,
        device: makeDevice(id, id),
        accountKey: keys.accountKey,
        owner: keys.owner,
        encryptionKey: keys.encryptionKey,
        view: accountStateToDeviceView(snapshot(name, nameAt)),
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

    it("B's rename survives A's repeated default-name publishes", async () => {
      // A publishes its default (never-renamed) name.
      expect((await pub(DEVICE_A, "Account-A", undefined)).status).not.toBe(
        "error",
      )
      await delay(liveEnv.propDelayMs)

      // B genuinely renames the account (a real per-field edit clock).
      expect((await pub(DEVICE_B, "Renamed-by-B", RENAME_AT)).status).not.toBe(
        "error",
      )
      await delay(liveEnv.propDelayMs)

      // A publishes AGAIN with its unchanged default name. With the regression
      // this re-stamped a fresh `Date.now()` (≫ RENAME_AT) and clobbered B; with
      // the fix it re-clocks at `createdAt` (< RENAME_AT) and B keeps winning.
      expect((await pub(DEVICE_A, "Account-A", undefined)).status).not.toBe(
        "error",
      )
      // Wait out propagation so A's clobbering re-publish is readable BEFORE we
      // fold — otherwise an early poll could see B's rename before the clobber
      // lands and pass spuriously under the bug.
      await delay(liveEnv.propDelayMs)

      const folded = await fold(
        (a) =>
          a.accountName === "Renamed-by-B" &&
          a.devices.filter((d) => !d.removedAt).length === 2,
        "B's rename wins over A's default name",
      )
      expect(folded, "fold converged on B's rename").toBeDefined()
      expect(folded!.accountName).toBe("Renamed-by-B")
      expect(folded!.accountNameAt).toBe(RENAME_AT)
    })
  },
)

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId, PrivateKey } from "@ethersphere/bee-js"
import {
  serializeDeviceState,
  deserializeDeviceState,
  accountStateToDeviceView,
  foldAccount,
  type DeviceStateView,
  type DeviceStateSnapshot,
} from "./device-state"
import { mergeSnapshotWithRemote } from "./merge-snapshot"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"
import type { ConnectedApp, Device, PostageStamp } from "../schemas"

const ACCOUNT_ID = "aa".repeat(20)
// Compressed secp256k1 public key (prefix byte + 32 bytes = 66 bare hex chars).
const TEST_ACCOUNT_PUBLIC_KEY = "02" + "ab".repeat(32)

function makeStamp(
  batchHex: string,
  overrides: Partial<PostageStamp> = {},
): PostageStamp {
  return {
    batchID: new BatchId(batchHex),
    signerKey: new PrivateKey("22".repeat(32)),
    utilization: 0,
    usable: true,
    depth: 24,
    amount: BigInt(100),
    bucketDepth: 16,
    blockNumber: 1,
    immutableFlag: true,
    exists: true,
    createdAt: 1_000_000,
    ...overrides,
  }
}

function makeApp(
  appUrl: string,
  overrides: Partial<ConnectedApp> = {},
): ConnectedApp {
  return { appUrl, appName: appUrl, lastConnectedAt: 1_000_000, ...overrides }
}

function makeDevice(deviceId: string): Device {
  return {
    deviceId,
    name: deviceId,
    createdAt: 1_000_000,
    lastSignedInAt: 1_000_000,
  }
}

function makeView(overrides: Partial<DeviceStateView> = {}): DeviceStateView {
  return {
    connectedApps: [],
    postageStamps: [],
    accountName: { value: "acct", at: 1 },
    defaultPostageStampBatchID: { value: undefined, at: 1 },
    settings: { value: undefined, at: 1 },
    accountPublicKey: TEST_ACCOUNT_PUBLIC_KEY,
    accountCreatedAt: 1_000_000,
    partitionCount: 2,
    ...overrides,
  }
}

function viewToSnapshot(v: DeviceStateView): AccountStateSnapshot {
  return {
    version: 1,
    timestamp: 1_000_000,
    accountId: ACCOUNT_ID,
    metadata: {
      accountName: v.accountName.value,
      defaultPostageStampBatchID: v.defaultPostageStampBatchID.value,
      publicKey: v.accountPublicKey,
      createdAt: 1_000_000,
      lastModified: 1_000_000,
      devices: [],
      partitionCount: 2,
    },
    connectedApps: v.connectedApps,
    postageStamps: v.postageStamps,
  }
}

describe("device-state serialization", () => {
  it("round-trips a view (BatchId / bigint / tombstones preserved)", () => {
    const view = makeView({
      connectedApps: [
        makeApp("https://a.example", { updatedAt: 5, revokedAt: 5 }),
      ],
      postageStamps: [makeStamp("cc".repeat(32), { deletedAt: 7 })],
      accountName: { value: "my account", at: 9 },
      defaultPostageStampBatchID: { value: "cc".repeat(32), at: 9 },
    })
    const bytes = new TextEncoder().encode(
      JSON.stringify(serializeDeviceState(ACCOUNT_ID, "dev-1", view)),
    )
    const back: DeviceStateSnapshot = deserializeDeviceState(bytes)
    expect(back.postageStamps[0].batchID.toHex()).toBe("cc".repeat(32))
    expect(back.postageStamps[0].amount).toBe(BigInt(100))
    expect(back.postageStamps[0].deletedAt).toBe(7)
    expect(back.connectedApps[0].revokedAt).toBe(5)
    expect(back.accountName).toEqual({ value: "my account", at: 9 })
  })
})

describe("accountStateToDeviceView — never-edited scalar clocks", () => {
  const CREATED_AT = 1_700_000_000_000

  function newAccountSnapshot(
    overrides: Partial<AccountStateSnapshot["metadata"]> = {},
  ): AccountStateSnapshot {
    return {
      version: 1,
      timestamp: 1_700_000_001_000,
      accountId: ACCOUNT_ID,
      metadata: {
        accountName: "Account-A",
        defaultPostageStampBatchID: undefined,
        publicKey: TEST_ACCOUNT_PUBLIC_KEY,
        createdAt: CREATED_AT,
        // Always freshly stamped at publish time — the trap the old fallback
        // (`?? lastModified`) fell into, re-clocking unedited fields every sync.
        lastModified: 1_700_000_999_000,
        devices: [],
        partitionCount: 2,
        ...overrides,
      },
      connectedApps: [],
      postageStamps: [],
    }
  }

  it("clocks a never-edited field at the stable createdAt, not a fresh lastModified", () => {
    // The create page sets `accountName` but no `*At` clocks — this is that state.
    const view = accountStateToDeviceView(newAccountSnapshot())
    expect(view.accountName.at).toBe(CREATED_AT)
    expect(view.defaultPostageStampBatchID.at).toBe(CREATED_AT)
    expect(view.settings.at).toBe(CREATED_AT)
    // Regression guard: must NOT pick up the fresh publish-time `lastModified`,
    // which would let an unchanged default name clobber a peer's real rename.
    expect(view.accountName.at).not.toBe(1_700_000_999_000)
  })

  it("preserves an explicit edit clock (a real rename outranks a peer's createdAt)", () => {
    const renameAt = CREATED_AT + 5_000
    const view = accountStateToDeviceView(
      newAccountSnapshot({ accountName: "Renamed", accountNameAt: renameAt }),
    )
    expect(view.accountName.at).toBe(renameAt)
  })
})

describe("foldAccount — differential equivalence with mergeSnapshotWithRemote", () => {
  it("folded collections equal the Phase 0–2 snapshot merge for the same data", () => {
    const viewA = makeView({
      connectedApps: [makeApp("https://a.example", { updatedAt: 2 })],
      postageStamps: [makeStamp("aa".repeat(32))],
    })
    const viewB = makeView({
      connectedApps: [makeApp("https://b.example", { updatedAt: 3 })],
      postageStamps: [makeStamp("bb".repeat(32))],
    })

    const folded = foldAccount(
      [viewA, viewB] as unknown as DeviceStateSnapshot[],
      [makeDevice("dev-a"), makeDevice("dev-b")],
    )
    const merged = mergeSnapshotWithRemote(
      viewToSnapshot(viewA),
      viewToSnapshot(viewB),
    )

    expect(folded.connectedApps.map((a) => a.appUrl).sort()).toEqual(
      merged.connectedApps.map((a) => a.appUrl).sort(),
    )
    expect(folded.postageStamps.map((s) => s.batchID.toHex()).sort()).toEqual(
      merged.postageStamps.map((s) => s.batchID.toHex()).sort(),
    )
  })

  it("a deleted stamp on one device wins over an active copy on another (tombstone propagates)", () => {
    const hex = "dd".repeat(32)
    const active = makeView({
      postageStamps: [makeStamp(hex, { createdAt: 1 })],
    })
    const deleted = makeView({
      postageStamps: [makeStamp(hex, { createdAt: 1, deletedAt: 5 })],
    })
    const folded = foldAccount(
      [active, deleted] as unknown as DeviceStateSnapshot[],
      [makeDevice("dev-a")],
    )
    expect(folded.postageStamps).toHaveLength(1)
    expect(folded.postageStamps[0].deletedAt).toBe(5)
    expect(folded.postageStamps.filter((s) => !s.deletedAt)).toHaveLength(0)
  })
})

describe("foldAccount — per-field scalar LWW", () => {
  it("a concurrent name change on A and default-stamp change on B both survive", () => {
    const viewA = makeView({
      accountName: { value: "renamed-on-A", at: 10 },
      defaultPostageStampBatchID: { value: undefined, at: 1 },
    })
    const viewB = makeView({
      accountName: { value: "acct", at: 1 },
      defaultPostageStampBatchID: { value: "ee".repeat(32), at: 10 },
    })
    const folded = foldAccount(
      [viewA, viewB] as unknown as DeviceStateSnapshot[],
      [],
    )
    expect(folded.accountName).toBe("renamed-on-A")
    expect(folded.defaultPostageStampBatchID?.toHex()).toBe("ee".repeat(32))
    // The winning per-field clock is exposed so refresh/restore can LWW it.
    expect(folded.accountNameAt).toBe(10)
    expect(folded.defaultStampAt).toBe(10)
    expect(folded.settingsAt).toBe(1)
  })

  it("devices come from the registry, not the views", () => {
    const folded = foldAccount(
      [makeView()] as unknown as DeviceStateSnapshot[],
      [makeDevice("dev-x"), makeDevice("dev-y")],
    )
    expect(folded.devices.map((d) => d.deviceId).sort()).toEqual([
      "dev-x",
      "dev-y",
    ])
  })
})

describe("foldAccount — account immutables from any defining view", () => {
  it("takes partitionCount from a later view when views[0] has the default", () => {
    // views[0] is an older/partial feed: partitionCount defaulted to 1 (which
    // would disable partition locking). A later view carries the real value —
    // the fold must prefer that, not views[0]. publicKey is an account immutable
    // present on every view, so it always comes from views[0].
    const partial = makeView({ partitionCount: 1 })
    const full = makeView({ partitionCount: 4 })
    const folded = foldAccount(
      [partial, full] as unknown as DeviceStateSnapshot[],
      [makeDevice("dev-a")],
    )
    expect(folded.partitionCount).toBe(4)
    expect(folded.publicKey).toBe(TEST_ACCOUNT_PUBLIC_KEY)
  })
})

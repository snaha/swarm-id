// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId, PrivateKey } from "@ethersphere/bee-js"
import {
  serializeDeviceState,
  deserializeDeviceState,
  foldAccount,
  type DeviceStateView,
  type DeviceStateSnapshot,
} from "./device-state"
import { mergeSnapshotWithRemote } from "./merge-snapshot"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"
import type { ConnectedApp, Device, PostageStamp } from "../schemas"

const ACCOUNT_ID = "aa".repeat(20)

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

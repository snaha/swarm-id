// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId, PrivateKey } from "@ethersphere/bee-js"
import {
  mergeSnapshotWithRemote,
  snapshotContainsContribution,
} from "./merge-snapshot"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"
import type { Device, ConnectedApp, PostageStamp } from "../schemas"

const SELF_DEVICE_ID = "device-self-111"
const OTHER_DEVICE_ID = "device-other-222"
const ACCOUNT_ID = "aa".repeat(20)

function makeDevice(deviceId: string, lastSignedInAt = 1_000_000): Device {
  return {
    deviceId,
    name: `Device ${deviceId.slice(-3)}`,
    createdAt: 1_000_000,
    lastSignedInAt,
  }
}

function makeStamp(batchHex: string): PostageStamp {
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
  }
}

function makeConnectedApp(appUrl: string): ConnectedApp {
  return {
    appUrl,
    appName: appUrl,
    lastConnectedAt: 1_000_000,
  }
}

function makeSnapshot(overrides: {
  devices?: Device[]
  connectedApps?: ConnectedApp[]
  postageStamps?: PostageStamp[]
  accountName?: string
  partitionCount?: number
}): AccountStateSnapshot {
  return {
    version: 1,
    timestamp: 1_000_000,
    accountId: ACCOUNT_ID,
    metadata: {
      accountName: overrides.accountName ?? "test account",
      defaultPostageStampBatchID: "cc".repeat(32),
      createdAt: 1_000_000,
      lastModified: 1_000_000,
      devices: overrides.devices ?? [],
      partitionCount: overrides.partitionCount ?? 4,
    },
    connectedApps: overrides.connectedApps ?? [],
    postageStamps: overrides.postageStamps ?? [],
  }
}

describe("mergeSnapshotWithRemote — devices union", () => {
  it("returns local unchanged when remote is undefined", () => {
    const local = makeSnapshot({ devices: [makeDevice(SELF_DEVICE_ID)] })
    const result = mergeSnapshotWithRemote(local, undefined)
    expect(result).toBe(local)
  })

  it("unions devices when each side has different entries", () => {
    const local = makeSnapshot({ devices: [makeDevice(SELF_DEVICE_ID)] })
    const remote = makeSnapshot({ devices: [makeDevice(OTHER_DEVICE_ID)] })
    const result = mergeSnapshotWithRemote(local, remote)
    const ids = result.metadata.devices.map((d) => d.deviceId).sort()
    expect(ids).toEqual([OTHER_DEVICE_ID, SELF_DEVICE_ID].sort())
  })

  it("prefers larger lastSignedInAt on duplicate deviceIds", () => {
    const local = makeSnapshot({
      devices: [makeDevice(SELF_DEVICE_ID, 5_000_000)],
    })
    const remote = makeSnapshot({
      devices: [makeDevice(SELF_DEVICE_ID, 1_000_000)],
    })
    const result = mergeSnapshotWithRemote(local, remote)
    const self = result.metadata.devices.find(
      (d) => d.deviceId === SELF_DEVICE_ID,
    )
    expect(self?.lastSignedInAt).toBe(5_000_000)
  })

  it("local wins on equal lastSignedInAt", () => {
    const local = makeSnapshot({
      devices: [{ ...makeDevice(SELF_DEVICE_ID, 1_000_000), name: "local" }],
    })
    const remote = makeSnapshot({
      devices: [{ ...makeDevice(SELF_DEVICE_ID, 1_000_000), name: "remote" }],
    })
    const result = mergeSnapshotWithRemote(local, remote)
    expect(
      result.metadata.devices.find((d) => d.deviceId === SELF_DEVICE_ID)?.name,
    ).toBe("local")
  })
})

describe("mergeSnapshotWithRemote — apps / stamps", () => {
  it("unions postage stamps by batchID, local wins on duplicate", () => {
    const localStamp = makeStamp("aa".repeat(32))
    const remoteStamp = makeStamp("bb".repeat(32))
    const result = mergeSnapshotWithRemote(
      makeSnapshot({ postageStamps: [localStamp] }),
      makeSnapshot({ postageStamps: [remoteStamp] }),
    )
    expect(result.postageStamps.map((s) => s.batchID.toHex()).sort()).toEqual(
      [localStamp.batchID.toHex(), remoteStamp.batchID.toHex()].sort(),
    )
  })

  it("unions connectedApps by appUrl", () => {
    const a = makeConnectedApp("https://app-a.example")
    const b = makeConnectedApp("https://app-b.example")
    const c = makeConnectedApp("https://app-c.example")
    const result = mergeSnapshotWithRemote(
      makeSnapshot({ connectedApps: [a] }),
      makeSnapshot({ connectedApps: [b, c] }),
    )
    expect(result.connectedApps).toHaveLength(3)
  })

  it("a newer remote revocation tombstone supersedes a stale local active app", () => {
    // The device-2 case: device 1 revoked the app and published a tombstone;
    // device 2 still has the app active. The newer tombstone must win so the
    // revocation propagates.
    const active = {
      ...makeConnectedApp("https://app.example"),
      updatedAt: 1_000_000,
    }
    const tombstone = {
      ...makeConnectedApp("https://app.example"),
      updatedAt: 5_000_000,
      revokedAt: 5_000_000,
      connectedUntil: undefined,
      appSecret: undefined,
    }
    const result = mergeSnapshotWithRemote(
      makeSnapshot({ connectedApps: [active] }), // local (device 2): still active
      makeSnapshot({ connectedApps: [tombstone] }), // remote (device 1): revoked
    )
    expect(result.connectedApps).toHaveLength(1)
    expect(result.connectedApps[0].revokedAt).toBe(5_000_000)
  })

  it("local revocation is not undone by an older remote active copy (publish merge)", () => {
    // The publish case: device 1 revoked locally; the remote snapshot still has
    // the app active (older). The union used to re-add it — LWW keeps the tombstone.
    const tombstone = {
      ...makeConnectedApp("https://app.example"),
      updatedAt: 5_000_000,
      revokedAt: 5_000_000,
    }
    const staleActive = {
      ...makeConnectedApp("https://app.example"),
      updatedAt: 1_000_000,
    }
    const result = mergeSnapshotWithRemote(
      makeSnapshot({ connectedApps: [tombstone] }), // local (device 1): revoked
      makeSnapshot({ connectedApps: [staleActive] }), // remote: still active (older)
    )
    expect(result.connectedApps).toHaveLength(1)
    expect(result.connectedApps[0].revokedAt).toBe(5_000_000)
  })
})

describe("mergeSnapshotWithRemote — scalar metadata fields", () => {
  it("local wins for accountName / partitionCount", () => {
    const result = mergeSnapshotWithRemote(
      makeSnapshot({ accountName: "local name", partitionCount: 4 }),
      makeSnapshot({ accountName: "remote name", partitionCount: 2 }),
    )
    expect(result.metadata.accountName).toBe("local name")
    expect(result.metadata.partitionCount).toBe(4)
  })

  it("refreshes lastModified and snapshot timestamp to now", () => {
    const before = Date.now()
    const result = mergeSnapshotWithRemote(makeSnapshot({}), makeSnapshot({}))
    const after = Date.now()
    expect(result.timestamp).toBeGreaterThanOrEqual(before)
    expect(result.timestamp).toBeLessThanOrEqual(after)
    expect(result.metadata.lastModified).toBeGreaterThanOrEqual(before)
  })
})

describe("snapshotContainsContribution", () => {
  it("is true when latest is a superset of mine (co-writer published us)", () => {
    const mine = makeSnapshot({ devices: [makeDevice(SELF_DEVICE_ID)] })
    const latest = makeSnapshot({
      devices: [makeDevice(SELF_DEVICE_ID), makeDevice(OTHER_DEVICE_ID)],
    })
    expect(snapshotContainsContribution(mine, latest)).toBe(true)
  })

  it("is true for equal sets (ignoring timestamps)", () => {
    const mine = makeSnapshot({
      devices: [makeDevice(SELF_DEVICE_ID, 1_000_000)],
      connectedApps: [makeConnectedApp("https://app.example")],
    })
    const latest = makeSnapshot({
      devices: [makeDevice(SELF_DEVICE_ID, 9_000_000)],
      connectedApps: [makeConnectedApp("https://app.example")],
    })
    expect(snapshotContainsContribution(mine, latest)).toBe(true)
  })

  it("is false when latest is missing my device (genuine loss)", () => {
    const mine = makeSnapshot({ devices: [makeDevice(SELF_DEVICE_ID)] })
    const latest = makeSnapshot({ devices: [makeDevice(OTHER_DEVICE_ID)] })
    expect(snapshotContainsContribution(mine, latest)).toBe(false)
  })

  it("is false when latest is missing one of my connected apps", () => {
    const mine = makeSnapshot({
      connectedApps: [makeConnectedApp("https://app.example")],
    })
    const latest = makeSnapshot({ connectedApps: [] })
    expect(snapshotContainsContribution(mine, latest)).toBe(false)
  })

  it("is false when latest is missing one of my postage stamps", () => {
    const mine = makeSnapshot({ postageStamps: [makeStamp("aa".repeat(32))] })
    const latest = makeSnapshot({ postageStamps: [makeStamp("bb".repeat(32))] })
    expect(snapshotContainsContribution(mine, latest)).toBe(false)
  })
})

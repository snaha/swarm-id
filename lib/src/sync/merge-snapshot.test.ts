// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId, EthAddress, PrivateKey } from "@ethersphere/bee-js"
import { mergeSnapshotWithRemote } from "./merge-snapshot"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"
import type { Device, Identity, ConnectedApp, PostageStamp } from "../schemas"

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

function makeIdentity(id: string): Identity {
  return {
    id: new EthAddress(id),
    accountId: new EthAddress(ACCOUNT_ID),
    name: `Identity ${id.slice(0, 6)}`,
    publicKey: new PrivateKey("11".repeat(32))
      .publicKey()
      .toCompressedUint8Array(),
    createdAt: 1_000_000,
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

function makeConnectedApp(identityId: string, appUrl: string): ConnectedApp {
  return {
    appUrl,
    appName: appUrl,
    lastConnectedAt: 1_000_000,
    identityId,
  }
}

function makeSnapshot(overrides: {
  devices?: Device[]
  identities?: Identity[]
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
    identities: overrides.identities ?? [],
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

describe("mergeSnapshotWithRemote — identities / apps / stamps", () => {
  it("unions identities by id with local winning on conflict", () => {
    const localOnly = makeIdentity("aa".padEnd(40, "0"))
    const remoteOnly = makeIdentity("bb".padEnd(40, "0"))
    const result = mergeSnapshotWithRemote(
      makeSnapshot({ identities: [localOnly] }),
      makeSnapshot({ identities: [remoteOnly] }),
    )
    const ids = result.identities.map((i) => i.id.toHex()).sort()
    expect(ids).toEqual([localOnly.id.toHex(), remoteOnly.id.toHex()].sort())
  })

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

  it("unions connectedApps by (identityId, appUrl)", () => {
    const a = makeConnectedApp("ident-1", "https://app-a.example")
    const b = makeConnectedApp("ident-1", "https://app-b.example")
    const c = makeConnectedApp("ident-2", "https://app-a.example") // same appUrl, different identity
    const result = mergeSnapshotWithRemote(
      makeSnapshot({ connectedApps: [a] }),
      makeSnapshot({ connectedApps: [b, c] }),
    )
    expect(result.connectedApps).toHaveLength(3)
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

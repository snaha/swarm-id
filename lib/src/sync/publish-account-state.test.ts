// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest"
import { PrivateKey, Reference, type Bee } from "@ethersphere/bee-js"
import type { Device } from "../schemas"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"
import { serializeAccountState } from "./serialization"

const ACCOUNT_ID = "aa".repeat(20)
const SELF_DEVICE_ID = "device-self-111"
const PEER_DEVICE_ID = "device-peer-222"
const FAKE_UPLOAD_REFERENCE = "ab".repeat(32)
// A different ref the feed can resolve to during verify, to exercise the
// content-aware "did my contribution land?" branch.
const FAKE_OTHER_REFERENCE = "cd".repeat(32)
const FAKE_SOC_ADDRESS = new Uint8Array(32).fill(0xee)

// Capture what publishAccountState uploads as the (merged) snapshot.
let capturedUploadData: Uint8Array | undefined
vi.mock("../proxy/upload", () => ({
  uploadData: vi.fn(async (_target: unknown, data: Uint8Array) => {
    capturedUploadData = data
    return {
      reference: FAKE_UPLOAD_REFERENCE,
      chunkAddresses: [new Uint8Array(32).fill(0xaa)],
    }
  }),
}))

// Both the pre-write remote fetch and the post-write verify read via findAt;
// returning the written ref makes the verify see our write as "won".
const mockFindAt = vi.fn(async () =>
  new Reference(FAKE_UPLOAD_REFERENCE).toUint8Array(),
)
vi.mock("../proxy/feeds/epochs", () => ({
  BasicEpochUpdater: class {
    update = vi.fn(async () => ({
      socAddress: FAKE_SOC_ADDRESS,
      epoch: { start: 0n, level: 0 },
      timestamp: 0n,
    }))
  },
  AsyncEpochFinder: class {
    findAt = mockFindAt
  },
}))

// The remote snapshot the pre-write fetch downloads + deserializes.
const mockDownloadData = vi.hoisted(() =>
  vi.fn(async (): Promise<Uint8Array> => new Uint8Array()),
)
vi.mock("../proxy/download-data", () => ({
  downloadDataWithChunkAPI: mockDownloadData,
}))

import {
  publishAccountState,
  remoteFeedHasDevice,
} from "./publish-account-state"
import { uploadData } from "../proxy/upload"

function makeDevice(deviceId: string): Device {
  return {
    deviceId,
    name: `Device ${deviceId.slice(-3)}`,
    createdAt: 1_000_000,
    lastSignedInAt: 1_000_000,
  }
}

function makeSnapshot(devices: Device[]): AccountStateSnapshot {
  return {
    version: 1,
    timestamp: 1_000_000,
    accountId: ACCOUNT_ID,
    metadata: {
      accountName: "test account",
      defaultPostageStampBatchID: "cc".repeat(32),
      createdAt: 1_000_000,
      lastModified: 1_000_000,
      devices,
      partitionCount: 4,
    },
    identities: [],
    connectedApps: [],
    postageStamps: [],
  }
}

function makeBee(): Bee {
  return {
    url: "http://mock-bee",
    downloadChunk: vi.fn().mockResolvedValue(new Uint8Array(105)),
  } as unknown as Bee
}

describe("publishAccountState — device announce", () => {
  beforeEach(() => {
    capturedUploadData = undefined
    mockFindAt.mockClear()
    mockDownloadData.mockReset()
  })

  it("merges the local device into the remote and uploads the union", async () => {
    // The remote feed (written by peers) knows only the peer device.
    mockDownloadData.mockResolvedValue(
      serializeAccountState(makeSnapshot([makeDevice(PEER_DEVICE_ID)])),
    )
    // This device's local snapshot announces itself.
    const local = makeSnapshot([makeDevice(SELF_DEVICE_ID)])

    const accountKey = new PrivateKey("33".repeat(32))
    const result = await publishAccountState({
      bee: makeBee(),
      accountId: ACCOUNT_ID,
      accountKey,
      owner: accountKey.publicKey().address(),
      encryptionKey: "44".repeat(32),
      localSnapshot: local,
      target: { mode: "stamper" } as never,
    })

    expect(result.status).toBe("success")
    expect(capturedUploadData).toBeDefined()

    // The uploaded (merged) snapshot must contain BOTH devices — i.e. the
    // newcomer announced itself without dropping the peer.
    const uploaded = JSON.parse(new TextDecoder().decode(capturedUploadData!))
    const deviceIds = uploaded.metadata.devices.map(
      (d: { deviceId: string }) => d.deviceId,
    )
    expect(deviceIds).toContain(SELF_DEVICE_ID)
    expect(deviceIds).toContain(PEER_DEVICE_ID)
  })

  it("publishes the local snapshot when there is no remote yet", async () => {
    mockFindAt.mockResolvedValueOnce(undefined) // pre-write fetch: empty feed
    const local = makeSnapshot([makeDevice(SELF_DEVICE_ID)])

    const accountKey = new PrivateKey("33".repeat(32))
    const result = await publishAccountState({
      bee: makeBee(),
      accountId: ACCOUNT_ID,
      accountKey,
      owner: accountKey.publicKey().address(),
      encryptionKey: "44".repeat(32),
      localSnapshot: local,
      target: { mode: "stamper" } as never,
    })

    expect(result.status).toBe("success")
    const uploaded = JSON.parse(new TextDecoder().decode(capturedUploadData!))
    const deviceIds = uploaded.metadata.devices.map(
      (d: { deviceId: string }) => d.deviceId,
    )
    expect(deviceIds).toEqual([SELF_DEVICE_ID])
  })
})

describe("remoteFeedHasDevice", () => {
  beforeEach(() => {
    mockFindAt.mockClear()
    mockDownloadData.mockReset()
  })

  const accountKey = new PrivateKey("33".repeat(32))
  const owner = accountKey.publicKey().address()

  it("returns true when the feed's latest snapshot lists the device", async () => {
    mockDownloadData.mockResolvedValue(
      serializeAccountState(makeSnapshot([makeDevice(SELF_DEVICE_ID)])),
    )
    await expect(
      remoteFeedHasDevice({
        bee: makeBee(),
        accountId: ACCOUNT_ID,
        owner,
        deviceId: SELF_DEVICE_ID,
      }),
    ).resolves.toBe(true)
  })

  it("returns false when the device is not in the feed", async () => {
    mockDownloadData.mockResolvedValue(
      serializeAccountState(makeSnapshot([makeDevice(PEER_DEVICE_ID)])),
    )
    await expect(
      remoteFeedHasDevice({
        bee: makeBee(),
        accountId: ACCOUNT_ID,
        owner,
        deviceId: SELF_DEVICE_ID,
      }),
    ).resolves.toBe(false)
  })

  it("returns false for an empty feed (so the device still announces itself)", async () => {
    mockFindAt.mockResolvedValueOnce(undefined)
    await expect(
      remoteFeedHasDevice({
        bee: makeBee(),
        accountId: ACCOUNT_ID,
        owner,
        deviceId: SELF_DEVICE_ID,
      }),
    ).resolves.toBe(false)
  })

  it("returns false when the feed read throws (never blocks the announce)", async () => {
    mockFindAt.mockRejectedValueOnce(new Error("bee 500"))
    await expect(
      remoteFeedHasDevice({
        bee: makeBee(),
        accountId: ACCOUNT_ID,
        owner,
        deviceId: SELF_DEVICE_ID,
      }),
    ).resolves.toBe(false)
  })
})

describe("publishAccountState — content-aware verify", () => {
  const accountKey = new PrivateKey("33".repeat(32))
  const owner = accountKey.publicKey().address()
  const deps = (localSnapshot: AccountStateSnapshot) => ({
    bee: makeBee(),
    accountId: ACCOUNT_ID,
    accountKey,
    owner,
    encryptionKey: "44".repeat(32),
    localSnapshot,
    target: { mode: "stamper" } as never,
  })

  beforeEach(() => {
    capturedUploadData = undefined
    mockFindAt.mockReset()
    mockDownloadData.mockReset()
    vi.mocked(uploadData).mockClear()
  })

  it("does NOT retry when a co-writer published a superset that still contains us", async () => {
    // The feed resolves to a DIFFERENT ref than we wrote (a concurrent writer —
    // e.g. the proxy announcing this device while the UI also syncs it), but that
    // snapshot still contains our device → convergence held → win, no storm.
    mockFindAt.mockResolvedValue(
      new Reference(FAKE_OTHER_REFERENCE).toUint8Array(),
    )
    mockDownloadData.mockResolvedValue(
      serializeAccountState(
        makeSnapshot([makeDevice(SELF_DEVICE_ID), makeDevice(PEER_DEVICE_ID)]),
      ),
    )
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await publishAccountState(
      deps(makeSnapshot([makeDevice(SELF_DEVICE_ID)])),
    )

    expect(result.status).toBe("success")
    expect(vi.mocked(uploadData)).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls.flat().join(" ")).not.toContain(
      "concurrent writer",
    )
    warnSpy.mockRestore()
  })

  it("retries and reports unverified when the winning snapshot DROPS our device", async () => {
    // The feed resolves to a different ref whose snapshot is missing our device →
    // a genuine last-writer-wins loss → re-merge/republish up to the budget.
    mockFindAt.mockResolvedValue(
      new Reference(FAKE_OTHER_REFERENCE).toUint8Array(),
    )
    mockDownloadData.mockResolvedValue(
      serializeAccountState(makeSnapshot([makeDevice(PEER_DEVICE_ID)])),
    )

    const result = await publishAccountState(
      deps(makeSnapshot([makeDevice(SELF_DEVICE_ID)])),
    )

    expect(result.status).toBe("success-unverified")
    expect(result.status === "success-unverified" && result.warning).toContain(
      "another device's publish won",
    )
    // 1 initial publish + MAX_PUBLISH_RETRIES (3) re-publishes.
    expect(vi.mocked(uploadData)).toHaveBeenCalledTimes(4)
  })

  it("treats an unreadable competing ref as won (no storm)", async () => {
    mockFindAt.mockResolvedValue(
      new Reference(FAKE_OTHER_REFERENCE).toUint8Array(),
    )
    mockDownloadData.mockRejectedValue(new Error("bee 500"))

    const result = await publishAccountState(
      deps(makeSnapshot([makeDevice(SELF_DEVICE_ID)])),
    )

    expect(result.status).toBe("success")
    expect(vi.mocked(uploadData)).toHaveBeenCalledTimes(1)
  })
})

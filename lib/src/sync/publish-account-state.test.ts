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

import { publishAccountState } from "./publish-account-state"

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

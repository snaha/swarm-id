// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest"
import { EthAddress, BatchId, type Bee } from "@ethersphere/bee-js"
import { createSyncAccount } from "./sync-account"
import { deserializeAccountState, serializeAccountState } from "./serialization"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"
import type {
  AccountsStoreInterface,
  IdentitiesStoreInterface,
  ConnectedAppsStoreInterface,
  PostageStampsStoreInterface,
} from "./store-interfaces"
import type { UtilizationStoreDB } from "../storage/utilization-store"
import type { DebouncedUtilizationUploader } from "../storage/debounced-uploader"
import {
  TEST_ETH_ADDRESS_HEX,
  TEST_IDENTITY_ADDRESS_HEX,
  TEST_BATCH_ID_HEX,
  createPasskeyAccount,
  createIdentity,
  createConnectedApp,
  createPostageStamp,
  createDevice,
} from "../test-fixtures"
import { PartitionContendedError } from "./batch-write-coordinator"

// ============================================================================
// Mock Factories
// ============================================================================

function createMockStores() {
  const account = createPasskeyAccount({
    credentialId: "test-credential",
    name: "Test Account",
    defaultPostageStampBatchID: new BatchId(TEST_BATCH_ID_HEX),
  })
  const identity = createIdentity()
  const connectedApp = createConnectedApp({ appSecret: undefined })
  const stamp = createPostageStamp()

  const accountsStore: AccountsStoreInterface = {
    getAccount: vi.fn((id: EthAddress) =>
      id.toHex() === TEST_ETH_ADDRESS_HEX ? account : undefined,
    ),
  }

  const identitiesStore: IdentitiesStoreInterface = {
    getIdentitiesByAccount: vi.fn((accountId: EthAddress) =>
      accountId.toHex() === TEST_ETH_ADDRESS_HEX ? [identity] : [],
    ),
  }

  const connectedAppsStore: ConnectedAppsStoreInterface = {
    getAppsByIdentityId: vi.fn((identityId: string) =>
      identityId === TEST_IDENTITY_ADDRESS_HEX ? [connectedApp] : [],
    ),
  }

  // Built on the mock stamper class's prototype so sync-account's
  // `instanceof UtilizationAwareStamper` narrowing accepts it.
  const mockStamper = Object.assign(
    Object.create(MockUtilizationAwareStamper.prototype) as Record<
      string,
      unknown
    >,
    {
      stamp: vi.fn().mockResolvedValue({
        batchId: new Uint8Array(32),
        index: new Uint8Array(8),
        timestamp: new Uint8Array(8),
        signature: new Uint8Array(65),
      }),
      flush: vi.fn().mockResolvedValue(undefined),
    },
  )

  const postageStampsStore: PostageStampsStoreInterface = {
    getStamp: vi.fn((batchID: BatchId) =>
      batchID.toHex() === TEST_BATCH_ID_HEX ? stamp : undefined,
    ),
    getStamper: vi.fn().mockResolvedValue(mockStamper),
    updateStampUtilization: vi.fn(),
  }

  return {
    accountsStore,
    identitiesStore,
    connectedAppsStore,
    postageStampsStore,
    mockStamper,
  }
}

// Bee mock with a downloadChunk that succeeds, so the post-upload verification
// probe in syncAccount sees the root chunk as retrievable and returns status
// "success" rather than "success-unverified".
function createMockBee(): Bee {
  return {
    url: "http://mock-bee",
    downloadChunk: vi.fn().mockResolvedValue(new Uint8Array(105)),
  } as unknown as Bee
}

// ============================================================================
// Upload & Epoch Mock Setup
// ============================================================================

// Track what was uploaded
let capturedUploadData: Uint8Array | undefined
let capturedEncryptionKey: Uint8Array | undefined
let uploadCallCount: number
let epochUpdateCallCount: number
let capturedEpochReference: Uint8Array | undefined

const FAKE_UPLOAD_REFERENCE = "ab".repeat(32)
const FAKE_SOC_ADDRESS = new Uint8Array(32).fill(0xee)

vi.mock("../proxy/upload", () => ({
  uploadData: vi.fn(
    async (
      _target: unknown,
      data: Uint8Array,
      options?: { encryptionKey?: Uint8Array | boolean },
    ) => {
      capturedUploadData = data
      capturedEncryptionKey = options?.encryptionKey as Uint8Array | undefined
      uploadCallCount++
      return {
        reference: FAKE_UPLOAD_REFERENCE,
        chunkAddresses: [new Uint8Array(32).fill(0xaa)],
      }
    },
  ),
}))

// Use a real class for the mock so `new BasicEpochUpdater(...)` works
const mockUpdate = vi.fn()
// Shared across all AsyncEpochFinder instances so a test can sequence both the
// pre-write remote fetch and the post-write verify reads (both go via findAt).
const mockFindAt = vi.fn(async (): Promise<Uint8Array | undefined> => undefined)

vi.mock("../proxy/feeds/epochs", () => {
  return {
    BasicEpochUpdater: class MockBasicEpochUpdater {
      update = mockUpdate
      getOwner = vi.fn(() => new EthAddress("a".repeat(40)))
    },
    // Pre-write remote-snapshot fetch + post-write verify both read via
    // AsyncEpochFinder; default returns empty so the merge sees no remote
    // state and the verify treats the write as "won".
    AsyncEpochFinder: class MockAsyncEpochFinder {
      findAt = mockFindAt
    },
  }
})

// tryFetchLatestSnapshot downloads + deserializes the snapshot the finder
// points at. Default is never reached (findAt → undefined); the verify-retry
// tests override it with a serialized peer snapshot. `vi.hoisted` so the
// reference is initialized before the hoisted `vi.mock` factory runs.
const mockDownloadData = vi.hoisted(() =>
  vi.fn(async (): Promise<Uint8Array> => new Uint8Array()),
)
vi.mock("../proxy/download-data", () => ({
  downloadDataWithChunkAPI: mockDownloadData,
}))

// Mock utilization to avoid complexity in these tests. The stamper class is a
// real (mock) class because sync-account narrows the store's stamper with
// `instanceof UtilizationAwareStamper` before handing it to the coordinator.
const MockUtilizationAwareStamper = vi.hoisted(
  () => class MockUtilizationAwareStamper {},
)
vi.mock("../utils/batch-utilization", () => ({
  updateAfterWrite: vi.fn().mockResolvedValue({
    state: { chunks: new Map() },
    tracker: { hasDirtyChunks: () => false, getDirtyChunks: () => [] },
  }),
  saveUtilizationState: vi.fn().mockResolvedValue(undefined),
  calculateUtilization: vi.fn().mockReturnValue(0.01),
  LEASE_TTL_MS: 30_000,
  UtilizationAwareStamper: MockUtilizationAwareStamper,
}))

// The write path (lock + partition lease + stamp flush) is the coordinator's
// job and is unit-tested in batch-write-coordinator.test.ts. Here we mock it so
// these tests cover sync-account's *use* of it: by default `withWrite` runs the
// publish op against a stamper target; a test can override `withWrite` to reject
// `PartitionContendedError` (the genuine-contention skip path).
const coordinatorController = vi.hoisted(() => ({
  withWrite: undefined as
    | undefined
    | ((op: (target: unknown) => Promise<unknown>) => Promise<unknown>),
}))
vi.mock("./batch-write-coordinator", () => ({
  BatchWriteCoordinator: class MockBatchWriteCoordinator {
    withWrite(op: (target: unknown) => Promise<unknown>) {
      return coordinatorController.withWrite
        ? coordinatorController.withWrite(op)
        : op({ mode: "stamper" })
    }
  },
  PartitionContendedError: class PartitionContendedError extends Error {
    accountId?: string
    constructor(message?: string, accountId?: string) {
      super(message ?? "All partitions are held by other devices.")
      this.name = "PartitionContendedError"
      this.accountId = accountId
    }
  },
}))

// device-id uses localStorage which isn't available in this test environment;
// stub it out with a fixed value.
vi.mock("../utils/device-id", () => ({
  getOrCreateDeviceId: vi.fn(() => "test-device-self"),
  getDeviceId: vi.fn(() => "test-device-self"),
  mergeDevices: vi.fn((existing: unknown[]) => existing),
  detectDeviceName: vi.fn(() => "Test Device"),
}))

// ============================================================================
// Tests
// ============================================================================

describe("createSyncAccount", () => {
  beforeEach(() => {
    capturedUploadData = undefined
    capturedEncryptionKey = undefined
    capturedEpochReference = undefined
    uploadCallCount = 0
    epochUpdateCallCount = 0

    coordinatorController.withWrite = undefined

    mockFindAt.mockReset()
    mockFindAt.mockResolvedValue(undefined)
    mockDownloadData.mockReset()
    mockDownloadData.mockResolvedValue(new Uint8Array())

    mockUpdate.mockReset()
    mockUpdate.mockImplementation(
      async (_timestamp: bigint, reference: Uint8Array) => {
        capturedEpochReference = reference
        epochUpdateCallCount++
        return {
          socAddress: FAKE_SOC_ADDRESS,
          epoch: { start: 0n, level: 0 },
          timestamp: BigInt(Math.floor(Date.now() / 1000)),
        }
      },
    )
  })

  it("should upload encrypted data and update epoch feed", async () => {
    const stores = createMockStores()

    const syncAccount = createSyncAccount({
      bee: createMockBee(),
      ...stores,
      utilizationStore: {} as UtilizationStoreDB,
      utilizationUploader: {
        scheduleUpload: vi.fn().mockResolvedValue(undefined),
      } as unknown as DebouncedUtilizationUploader,
    })

    const result = await syncAccount(TEST_ETH_ADDRESS_HEX)

    expect(result).toBeDefined()
    expect(result!.status).toBe("success")
    if (result!.status !== "success") return

    // Verify upload happened
    expect(uploadCallCount).toBe(1)
    expect(capturedUploadData).toBeDefined()
    expect(capturedEncryptionKey).toBeDefined()

    // Verify epoch feed was updated
    expect(epochUpdateCallCount).toBe(1)
    expect(capturedEpochReference).toBeDefined()

    // Verify result contains reference and chunk addresses
    expect(result.reference).toBe(FAKE_UPLOAD_REFERENCE)
    expect(result.chunkAddresses.length).toBeGreaterThanOrEqual(2) // data chunks + SOC
  })

  it("should serialize account state with all fields including accountName", async () => {
    const stores = createMockStores()

    const syncAccount = createSyncAccount({
      bee: createMockBee(),
      ...stores,
      utilizationStore: {} as UtilizationStoreDB,
      utilizationUploader: {
        scheduleUpload: vi.fn().mockResolvedValue(undefined),
      } as unknown as DebouncedUtilizationUploader,
    })

    await syncAccount(TEST_ETH_ADDRESS_HEX)

    // Deserialize the captured upload data to verify contents
    expect(capturedUploadData).toBeDefined()
    const deserialized = deserializeAccountState(capturedUploadData!)

    expect(deserialized.version).toBe(1)
    expect(deserialized.accountId).toBe(TEST_ETH_ADDRESS_HEX)
    expect(deserialized.metadata.accountName).toBe("Test Account")
    expect(deserialized.metadata.defaultPostageStampBatchID).toBe(
      TEST_BATCH_ID_HEX,
    )
    expect(deserialized.metadata.createdAt).toBe(1700000000000)
    expect(deserialized.identities).toHaveLength(1)
    expect(deserialized.identities[0].name).toBe("Default Identity")
    expect(deserialized.connectedApps).toHaveLength(1)
    expect(deserialized.connectedApps[0].appName).toBe("Test App")
    expect(deserialized.postageStamps).toHaveLength(1)
    expect(deserialized.postageStamps[0].depth).toBe(20)
  })

  it("should return undefined when account not found", async () => {
    const stores = createMockStores()
    ;(
      stores.accountsStore.getAccount as ReturnType<typeof vi.fn>
    ).mockReturnValue(undefined)

    const syncAccount = createSyncAccount({
      bee: createMockBee(),
      ...stores,
      utilizationStore: {} as UtilizationStoreDB,
      utilizationUploader: {
        scheduleUpload: vi.fn().mockResolvedValue(undefined),
      } as unknown as DebouncedUtilizationUploader,
    })

    const result = await syncAccount(TEST_ETH_ADDRESS_HEX)
    expect(result).toBeUndefined()
    expect(uploadCallCount).toBe(0)
  })

  it("should return undefined when no default stamp available", async () => {
    const stores = createMockStores()
    const account = createPasskeyAccount({
      defaultPostageStampBatchID: new BatchId(TEST_BATCH_ID_HEX),
    })
    ;(
      stores.accountsStore.getAccount as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      ...account,
      defaultPostageStampBatchID: undefined,
    })
    ;(
      stores.identitiesStore.getIdentitiesByAccount as ReturnType<typeof vi.fn>
    ).mockReturnValue([
      { ...createIdentity(), defaultPostageStampBatchID: undefined },
    ])

    const syncAccount = createSyncAccount({
      bee: createMockBee(),
      ...stores,
      utilizationStore: {} as UtilizationStoreDB,
      utilizationUploader: {
        scheduleUpload: vi.fn().mockResolvedValue(undefined),
      } as unknown as DebouncedUtilizationUploader,
    })

    const result = await syncAccount(TEST_ETH_ADDRESS_HEX)
    expect(result).toBeUndefined()
    expect(uploadCallCount).toBe(0)
  })

  it("should include account devices in synced metadata", async () => {
    const device = createDevice()
    const stores = createMockStores()
    ;(
      stores.accountsStore.getAccount as ReturnType<typeof vi.fn>
    ).mockReturnValue(
      createPasskeyAccount({
        defaultPostageStampBatchID: new BatchId(TEST_BATCH_ID_HEX),
        devices: [device],
      }),
    )

    const syncAccount = createSyncAccount({
      bee: createMockBee(),
      ...stores,
      utilizationStore: {} as UtilizationStoreDB,
      utilizationUploader: {
        scheduleUpload: vi.fn().mockResolvedValue(undefined),
      } as unknown as DebouncedUtilizationUploader,
    })

    await syncAccount(TEST_ETH_ADDRESS_HEX)

    expect(capturedUploadData).toBeDefined()
    const deserialized = deserializeAccountState(capturedUploadData!)

    expect(deserialized.metadata.devices).toHaveLength(1)
    expect(deserialized.metadata.devices[0].deviceId).toBe(device.deviceId)
  })

  it("should include SOC address in returned chunk addresses", async () => {
    const stores = createMockStores()

    const syncAccount = createSyncAccount({
      bee: createMockBee(),
      ...stores,
      utilizationStore: {} as UtilizationStoreDB,
      utilizationUploader: {
        scheduleUpload: vi.fn().mockResolvedValue(undefined),
      } as unknown as DebouncedUtilizationUploader,
    })

    const result = await syncAccount(TEST_ETH_ADDRESS_HEX)
    expect(result).toBeDefined()
    expect(result!.status).toBe("success")
    if (result!.status !== "success") return

    // Last address should be the SOC address from epoch feed update
    const lastAddress = result.chunkAddresses[result.chunkAddresses.length - 1]
    expect(lastAddress).toEqual(FAKE_SOC_ADDRESS)
  })

  it("publishes for a multi-device account when the coordinator holds a partition", async () => {
    const stores = createMockStores()
    const baseAccount = stores.accountsStore.getAccount(
      new EthAddress(TEST_ETH_ADDRESS_HEX),
    )!
    stores.accountsStore.getAccount = vi.fn((id: EthAddress) =>
      id.toHex() === TEST_ETH_ADDRESS_HEX
        ? { ...baseAccount, partitionCount: 2 }
        : undefined,
    )

    // Default coordinator mock runs the publish op (i.e. a partition was held /
    // claimed). The claim/skip decision itself is covered by
    // batch-write-coordinator.test.ts.
    const syncAccount = createSyncAccount({
      bee: createMockBee(),
      ...stores,
      utilizationStore: {} as UtilizationStoreDB,
      utilizationUploader: {
        scheduleUpload: vi.fn().mockResolvedValue(undefined),
      } as unknown as DebouncedUtilizationUploader,
    })

    const result = await syncAccount(TEST_ETH_ADDRESS_HEX)
    expect(result).toBeDefined()
    expect(result!.status).toBe("success")
    expect(uploadCallCount).toBe(1)
  })

  it("skips sync (returns undefined, no upload) when the coordinator reports contention", async () => {
    const stores = createMockStores()
    const baseAccount = stores.accountsStore.getAccount(
      new EthAddress(TEST_ETH_ADDRESS_HEX),
    )!
    stores.accountsStore.getAccount = vi.fn((id: EthAddress) =>
      id.toHex() === TEST_ETH_ADDRESS_HEX
        ? { ...baseAccount, partitionCount: 2 }
        : undefined,
    )

    // Every partition held by a live foreign device → withWrite throws
    // PartitionContendedError → sync-account skips quietly.
    coordinatorController.withWrite = () =>
      Promise.reject(
        new PartitionContendedError(undefined, TEST_ETH_ADDRESS_HEX),
      )

    const syncAccount = createSyncAccount({
      bee: createMockBee(),
      ...stores,
      utilizationStore: {} as UtilizationStoreDB,
      utilizationUploader: {
        scheduleUpload: vi.fn().mockResolvedValue(undefined),
      } as unknown as DebouncedUtilizationUploader,
    })

    const result = await syncAccount(TEST_ETH_ADDRESS_HEX)
    expect(result).toBeUndefined()
    expect(uploadCallCount).toBe(0)
    expect(epochUpdateCallCount).toBe(0)
  })

  it("returns a status:error result when the coordinator write fails operationally", async () => {
    const stores = createMockStores()

    // A non-contention failure (e.g. a stamp/SOC error) must surface as an
    // error result, NOT be swallowed as contention.
    coordinatorController.withWrite = () =>
      Promise.reject(new Error("SOC upload failed: 400 invalid batch id"))

    const syncAccount = createSyncAccount({
      bee: createMockBee(),
      ...stores,
      utilizationStore: {} as UtilizationStoreDB,
      utilizationUploader: {
        scheduleUpload: vi.fn().mockResolvedValue(undefined),
      } as unknown as DebouncedUtilizationUploader,
    })

    const result = await syncAccount(TEST_ETH_ADDRESS_HEX)
    expect(result).toBeDefined()
    expect(result!.status).toBe("error")
    expect(uploadCallCount).toBe(0)
  })

  // A peer snapshot already on Swarm, carrying a connected app we don't hold
  // locally. A correct retry must fold this in (union) rather than drop it.
  function makePeerSnapshot(): AccountStateSnapshot {
    const peerApp = createConnectedApp({
      appUrl: "https://peer.example.com",
      appName: "Peer App",
      appSecret: undefined,
    })
    return {
      version: 1,
      timestamp: 1700000000000,
      accountId: TEST_ETH_ADDRESS_HEX,
      metadata: {
        accountName: "Test Account",
        defaultPostageStampBatchID: TEST_BATCH_ID_HEX,
        createdAt: 1700000000000,
        lastModified: 1700000000000,
        devices: [],
        partitionCount: 1,
      },
      identities: [createIdentity()],
      connectedApps: [peerApp],
      postageStamps: [createPostageStamp()],
    }
  }

  it("re-merges and republishes when a peer overwrites the feed between write and verify", async () => {
    const stores = createMockStores()
    mockDownloadData.mockResolvedValue(
      serializeAccountState(makePeerSnapshot()),
    )

    // FAKE_UPLOAD_REFERENCE is 32 bytes of 0xab; the verify compares the
    // feed's current reference against the one we wrote.
    const ourRef = new Uint8Array(32).fill(0xab)
    const peerRef = new Uint8Array(32).fill(0xcd)
    mockFindAt
      .mockResolvedValueOnce(undefined) // publish #1 pre-write fetch: no remote
      .mockResolvedValueOnce(peerRef) // verify #1: a peer overwrote us
      .mockResolvedValueOnce(peerRef) // publish #2 pre-write fetch: peer snapshot
      .mockResolvedValueOnce(ourRef) // verify #2: our write won
      .mockResolvedValue(ourRef)

    const syncAccount = createSyncAccount({
      bee: createMockBee(),
      ...stores,
      utilizationStore: {} as UtilizationStoreDB,
      utilizationUploader: {
        scheduleUpload: vi.fn().mockResolvedValue(undefined),
      } as unknown as DebouncedUtilizationUploader,
    })

    const result = await syncAccount(TEST_ETH_ADDRESS_HEX)

    expect(result).toBeDefined()
    expect(result!.status).toBe("success")
    // One initial publish + one retry.
    expect(uploadCallCount).toBe(2)
    expect(epochUpdateCallCount).toBe(2)
    // The re-published snapshot is the union of our local app and the peer's.
    expect(capturedUploadData).toBeDefined()
    const republished = deserializeAccountState(capturedUploadData!)
    const appNames = republished.connectedApps.map((a) => a.appName).sort()
    expect(appNames).toEqual(["Peer App", "Test App"])
  })

  it("gives up with success-unverified after the retry budget when a peer keeps winning", async () => {
    const stores = createMockStores()
    mockDownloadData.mockResolvedValue(
      serializeAccountState(makePeerSnapshot()),
    )

    // The verify never sees our reference, so every attempt looks lost.
    mockFindAt.mockResolvedValue(new Uint8Array(32).fill(0xcd))

    const syncAccount = createSyncAccount({
      bee: createMockBee(),
      ...stores,
      utilizationStore: {} as UtilizationStoreDB,
      utilizationUploader: {
        scheduleUpload: vi.fn().mockResolvedValue(undefined),
      } as unknown as DebouncedUtilizationUploader,
    })

    const result = await syncAccount(TEST_ETH_ADDRESS_HEX)

    expect(result).toBeDefined()
    expect(result!.status).toBe("success-unverified")
    // 1 initial publish + MAX_PUBLISH_RETRIES (3) retries.
    expect(uploadCallCount).toBe(4)
    expect(epochUpdateCallCount).toBe(4)
  })
})

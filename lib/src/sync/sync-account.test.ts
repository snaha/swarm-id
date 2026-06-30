// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest"
import { EthAddress, BatchId, type Bee } from "@ethersphere/bee-js"
import { createSyncAccount } from "./sync-account"
import { deserializeDeviceState } from "./device-state"
import { ensureInRoster } from "./device-roster"
import type {
  AccountsStoreInterface,
  PostageStampsStoreInterface,
} from "./store-interfaces"
import type { UtilizationStoreDB } from "../storage/utilization-store"
import type { DebouncedUtilizationUploader } from "../storage/debounced-uploader"
import {
  TEST_ETH_ADDRESS_HEX,
  TEST_BATCH_ID_HEX,
  createAccount,
  createConnectedApp,
  createPostageStamp,
} from "../test-fixtures"
import { PartitionContendedError } from "./batch-write-coordinator"

// ============================================================================
// Mock Factories
// ============================================================================

function createMockStores(
  accountOverrides?: Partial<ReturnType<typeof createAccount>>,
) {
  const connectedApp = createConnectedApp({ appSecret: undefined })
  const stamp = createPostageStamp()
  const account = createAccount({
    name: "Test Account",
    defaultPostageStampBatchID: new BatchId(TEST_BATCH_ID_HEX),
    connectedApps: [connectedApp],
    postageStamps: [stamp],
    ...accountOverrides,
  })

  const accountsStore: AccountsStoreInterface = {
    get: vi.fn((id: EthAddress) =>
      id.toHex() === TEST_ETH_ADDRESS_HEX ? account : undefined,
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

// Track what was uploaded. Phase 3a writes TWO feeds per sync (the device-state
// blob, then the device-registry blob), so capture every upload in order;
// `capturedUploadData` keeps the last for back-compat.
let capturedUploads: Uint8Array[]
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
      capturedUploads.push(data)
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

// Mock utilization to avoid complexity in these tests. Partial mock: real
// constants (e.g. NUM_BUCKETS) stay available to transitive imports like
// partition-state's module-scope schema. The stamper class override is a real
// (mock) class because sync-account narrows the store's stamper with
// `instanceof UtilizationAwareStamper` before handing it to the coordinator.
const MockUtilizationAwareStamper = vi.hoisted(
  () => class MockUtilizationAwareStamper {},
)
vi.mock("../utils/batch-utilization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/batch-utilization")>()),
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

// The append-only roster does its own Swarm I/O (sequential feed + makeSOCReader)
// that the bee mock here doesn't cover; mock it so these tests focus on the
// device-state write. Roster behaviour is exercised by the integration test.
vi.mock("./device-roster", () => ({
  ensureInRoster: vi.fn(async () => {}),
  readRoster: vi.fn(async () => []),
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
    capturedUploads = []
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

    // Phase 3a writes the device-state feed (the roster append is mocked here).
    expect(uploadCallCount).toBe(1)
    expect(capturedUploadData).toBeDefined()
    expect(capturedEncryptionKey).toBeDefined()
    expect(epochUpdateCallCount).toBe(1)
    expect(capturedEpochReference).toBeDefined()

    // Verify result contains reference and chunk addresses (data chunk + SOC).
    expect(result.reference).toBe(FAKE_UPLOAD_REFERENCE)
    expect(result.chunkAddresses.length).toBeGreaterThanOrEqual(2)
  })

  it("writes this device's view to its own device-state feed", async () => {
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

    // First upload is the device-state blob (the second is the registry).
    const view = deserializeDeviceState(capturedUploads[0])
    expect(view.version).toBe(1)
    expect(view.accountId).toBe(TEST_ETH_ADDRESS_HEX)
    expect(view.accountName.value).toBe("Test Account")
    expect(view.defaultPostageStampBatchID.value).toBe(TEST_BATCH_ID_HEX)
    expect(view.connectedApps).toHaveLength(1)
    expect(view.connectedApps[0].appName).toBe("Test App")
    expect(view.postageStamps).toHaveLength(1)
    expect(view.postageStamps[0].depth).toBe(20)
  })

  it("keeps an unedited scalar's clock at createdAt, not lastModified", async () => {
    // The account was created long ago and NEVER renamed (accountNameAt unset),
    // but a later edit to a different field bumped lastModified. The published
    // view's scalar clocks must stay at the stable createdAt — restamping them
    // with a fresh lastModified would let this device clobber a peer's genuine
    // concurrent rename / default-stamp / settings change under per-field LWW
    // (§9.3, the hazard accountStateToDeviceView's createdAt fallback guards).
    const CREATED_AT = 1_000
    const LAST_MODIFIED = 5_000
    const stores = createMockStores({
      createdAt: CREATED_AT,
      lastModified: LAST_MODIFIED,
      // accountNameAt / defaultStampAt / settingsAt intentionally unset.
    })

    const syncAccount = createSyncAccount({
      bee: createMockBee(),
      ...stores,
      utilizationStore: {} as UtilizationStoreDB,
      utilizationUploader: {
        scheduleUpload: vi.fn().mockResolvedValue(undefined),
      } as unknown as DebouncedUtilizationUploader,
    })

    await syncAccount(TEST_ETH_ADDRESS_HEX)

    const view = deserializeDeviceState(capturedUploads[0])
    expect(view.accountName.at).toBe(CREATED_AT)
    expect(view.defaultPostageStampBatchID.at).toBe(CREATED_AT)
    expect(view.settings.at).toBe(CREATED_AT)
  })

  it("should return undefined when account not found", async () => {
    const stores = createMockStores()
    ;(stores.accountsStore.get as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined,
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
  })

  it("should return undefined when no default stamp available", async () => {
    const stores = createMockStores()
    const account = createAccount({
      defaultPostageStampBatchID: new BatchId(TEST_BATCH_ID_HEX),
    })
    ;(stores.accountsStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
      ...account,
      defaultPostageStampBatchID: undefined,
    })

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

  it("announces the publishing device in the roster", async () => {
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

    expect(ensureInRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        device: expect.objectContaining({ deviceId: "test-device-self" }),
      }),
    )
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
    const baseAccount = stores.accountsStore.get(
      new EthAddress(TEST_ETH_ADDRESS_HEX),
    )!
    stores.accountsStore.get = vi.fn((id: EthAddress) =>
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
    // device-state write (roster append mocked).
    expect(uploadCallCount).toBe(1)
  })

  it("skips sync (returns undefined, no upload) when the coordinator reports contention", async () => {
    const stores = createMockStores()
    const baseAccount = stores.accountsStore.get(
      new EthAddress(TEST_ETH_ADDRESS_HEX),
    )!
    stores.accountsStore.get = vi.fn((id: EthAddress) =>
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

  // (Removed: the shared-feed verifyWon re-merge/republish + success-unverified
  // tests — Phase 3a writes each device's own feed, so there is no shared-feed
  // collision to verify against. Per-device convergence is covered by
  // device-state.test.ts (differential fold) and the integration test.)
})

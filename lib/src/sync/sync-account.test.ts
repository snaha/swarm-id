import { describe, it, expect, vi, beforeEach } from "vitest"
import { EthAddress, BatchId } from "@ethersphere/bee-js"
import { createSyncAccount } from "./sync-account"
import { deserializeAccountState } from "./serialization"
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
  TEST_BATCH_ID_HEX,
  createPasskeyAccount,
  createIdentity,
  createConnectedApp,
  createPostageStamp,
} from "../test-fixtures"

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
      identityId === "identity-1" ? [connectedApp] : [],
    ),
  }

  const mockStamper = {
    stamp: vi.fn().mockResolvedValue({
      batchId: new Uint8Array(32),
      index: new Uint8Array(8),
      timestamp: new Uint8Array(8),
      signature: new Uint8Array(65),
    }),
    flush: vi.fn().mockResolvedValue(undefined),
  }

  const postageStampsStore: PostageStampsStoreInterface = {
    getStamp: vi.fn((batchID: BatchId) =>
      batchID.toHex() === TEST_BATCH_ID_HEX ? stamp : undefined,
    ),
    getStampsByAccount: vi.fn((accountId: string) =>
      accountId === TEST_ETH_ADDRESS_HEX ? [stamp] : [],
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

vi.mock("../proxy/upload-encrypted-data", () => ({
  uploadEncryptedDataWithSigning: vi.fn(
    async (
      _context: unknown,
      data: Uint8Array,
      encryptionKey: Uint8Array | undefined,
    ) => {
      capturedUploadData = data
      capturedEncryptionKey = encryptionKey
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

vi.mock("../proxy/feeds/epochs", () => {
  return {
    BasicEpochUpdater: class MockBasicEpochUpdater {
      update = mockUpdate
      getOwner = vi.fn(() => new EthAddress("a".repeat(40)))
    },
  }
})

// Mock utilization to avoid complexity in these tests
vi.mock("../utils/batch-utilization", () => ({
  updateAfterWrite: vi.fn().mockResolvedValue({
    state: { chunks: new Map() },
    tracker: { hasDirtyChunks: () => false, getDirtyChunks: () => [] },
  }),
  saveUtilizationState: vi.fn().mockResolvedValue(undefined),
  calculateUtilization: vi.fn().mockReturnValue(0.01),
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
      bee: {} as never,
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
      bee: {} as never,
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
      bee: {} as never,
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
      bee: {} as never,
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

  it("should include SOC address in returned chunk addresses", async () => {
    const stores = createMockStores()

    const syncAccount = createSyncAccount({
      bee: {} as never,
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
})

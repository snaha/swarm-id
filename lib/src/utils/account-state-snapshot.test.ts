import { describe, it, expect } from "vitest"
import { EthAddress, BatchId, PrivateKey } from "@ethersphere/bee-js"
import {
  serializeAccountStateSnapshot,
  deserializeAccountStateSnapshot,
  AccountStateSnapshotSchemaV1,
} from "./account-state-snapshot"
import type { Account, ConnectedApp, PostageStamp } from "../schemas"
import {
  TEST_ETH_ADDRESS_HEX,
  TEST_BATCH_ID_HEX,
  TEST_BATCH_ID_2_HEX,
  TEST_PRIVATE_KEY_HEX,
  createPasskeyAccount,
  createEthereumAccount,
  createAgentAccount,
  createIdentity,
  createConnectedApp,
  createPostageStamp,
} from "../test-fixtures"

/**
 * Helper: extract metadata from an Account and serialize via the snapshot function.
 */
function serializeFromAccount(
  account: Account,
  identities: Parameters<typeof serializeAccountStateSnapshot>[0]["identities"],
  connectedApps: Parameters<
    typeof serializeAccountStateSnapshot
  >[0]["connectedApps"],
  postageStamps: Parameters<
    typeof serializeAccountStateSnapshot
  >[0]["postageStamps"],
) {
  return serializeAccountStateSnapshot({
    accountId: account.id.toHex(),
    metadata: {
      accountName: account.name,
      defaultPostageStampBatchID: account.defaultPostageStampBatchID?.toHex(),
      createdAt: account.createdAt,
      lastModified: Date.now(),
    },
    identities,
    connectedApps,
    postageStamps,
    timestamp: Date.now(),
  })
}

// ============================================================================
// Round-trip Tests
// ============================================================================

describe("round-trip: serialize → JSON → deserialize", () => {
  it("should round-trip a passkey account with identities, apps, and stamps", () => {
    const account = createPasskeyAccount()
    const identities = [createIdentity()]
    const connectedApps = [createConnectedApp()]
    const postageStamps = [createPostageStamp()]

    const serialized = serializeFromAccount(
      account,
      identities,
      connectedApps,
      postageStamps,
    )
    const json = JSON.stringify(serialized)
    const parsed = JSON.parse(json)
    const result = deserializeAccountStateSnapshot(parsed)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.accountId).toBe(TEST_ETH_ADDRESS_HEX)
    expect(result.data.metadata.accountName).toBe("Test Passkey Account")
    expect(result.data.identities).toHaveLength(1)
    expect(result.data.identities[0].accountId).toBeInstanceOf(EthAddress)
    expect(result.data.connectedApps).toHaveLength(1)
    expect(result.data.connectedApps[0].appName).toBe("Test App")
    expect(result.data.postageStamps).toHaveLength(1)
    expect(result.data.postageStamps[0].batchID).toBeInstanceOf(BatchId)
    expect(result.data.postageStamps[0].signerKey).toBeInstanceOf(PrivateKey)
  })

  it("should round-trip an ethereum account with metadata", () => {
    const account = createEthereumAccount()
    const identities = [createIdentity()]
    const connectedApps: ConnectedApp[] = []
    const postageStamps: PostageStamp[] = []

    const serialized = serializeFromAccount(
      account,
      identities,
      connectedApps,
      postageStamps,
    )
    const json = JSON.stringify(serialized)
    const parsed = JSON.parse(json)
    const result = deserializeAccountStateSnapshot(parsed)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.accountId).toBe(TEST_ETH_ADDRESS_HEX)
    expect(result.data.metadata.accountName).toBe("Test Ethereum Account")
    expect(result.data.metadata.createdAt).toBe(1700000000000)
  })

  it("should round-trip an agent account", () => {
    const account = createAgentAccount()
    const identities = [createIdentity()]
    const connectedApps: ConnectedApp[] = []
    const postageStamps: PostageStamp[] = []

    const serialized = serializeFromAccount(
      account,
      identities,
      connectedApps,
      postageStamps,
    )
    const json = JSON.stringify(serialized)
    const parsed = JSON.parse(json)
    const result = deserializeAccountStateSnapshot(parsed)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.metadata.accountName).toBe("Test Agent Account")
  })

  it("should produce valid JSON for actual file I/O simulation", () => {
    const account = createPasskeyAccount({
      defaultPostageStampBatchID: new BatchId(TEST_BATCH_ID_HEX),
    })
    const identities = [
      createIdentity({ settings: { appSessionDuration: 3600 } }),
    ]
    const connectedApps = [
      createConnectedApp({
        appIcon: "https://example.com/icon.png",
        appDescription: "A test app",
        connectedUntil: 1700100000000,
      }),
    ]
    const postageStamps = [createPostageStamp({ batchTTL: 86400 })]

    const serialized = serializeFromAccount(
      account,
      identities,
      connectedApps,
      postageStamps,
    )

    // Simulate file write + read
    const fileContent = JSON.stringify(serialized, undefined, 2)
    const fileData = JSON.parse(fileContent)
    const result = deserializeAccountStateSnapshot(fileData)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.metadata.defaultPostageStampBatchID).toBe(
      TEST_BATCH_ID_HEX,
    )
    expect(result.data.identities[0].settings?.appSessionDuration).toBe(3600)
    expect(result.data.connectedApps[0].appIcon).toBe(
      "https://example.com/icon.png",
    )
    expect(result.data.postageStamps[0].batchTTL).toBe(86400)
  })
})

// ============================================================================
// appSecret Persistence Tests
// ============================================================================

describe("appSecret in snapshots", () => {
  it("should include appSecret in serialized export when present on input", () => {
    const account = createPasskeyAccount()
    const connectedApps = [createConnectedApp({ appSecret: "my-secret-value" })]

    const serialized = serializeFromAccount(account, [], connectedApps, [])

    const apps = serialized.connectedApps as Record<string, unknown>[]
    expect(apps[0]).toHaveProperty("appSecret", "my-secret-value")
  })

  it("should preserve appSecret through round-trip", () => {
    const account = createPasskeyAccount()
    const serialized = serializeFromAccount(account, [], [], [])

    const raw = JSON.parse(JSON.stringify(serialized))
    raw.connectedApps = [
      {
        appUrl: "https://example.com",
        appName: "Test App",
        lastConnectedAt: 1700000000000,
        identityId: "identity-1",
        appSecret: "preserved-secret",
      },
    ]

    const result = deserializeAccountStateSnapshot(raw)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.connectedApps[0].appSecret).toBe("preserved-secret")
  })
})

// ============================================================================
// Edge Cases
// ============================================================================

describe("edge cases", () => {
  it("should handle empty arrays for identities, connectedApps, and postageStamps", () => {
    const account = createPasskeyAccount()
    const serialized = serializeFromAccount(account, [], [], [])
    const result = deserializeAccountStateSnapshot(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.identities).toEqual([])
    expect(result.data.connectedApps).toEqual([])
    expect(result.data.postageStamps).toEqual([])
  })

  it("should handle optional fields absent on identity", () => {
    const identity = createIdentity({
      settings: undefined,
      defaultPostageStampBatchID: undefined,
    })
    const serialized = serializeFromAccount(
      createPasskeyAccount(),
      [identity],
      [],
      [],
    )
    const result = deserializeAccountStateSnapshot(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.identities[0].settings).toBeUndefined()
    expect(result.data.identities[0].defaultPostageStampBatchID).toBeUndefined()
  })

  it("should handle optional fields absent on connected app", () => {
    const app = createConnectedApp({
      appIcon: undefined,
      appDescription: undefined,
      connectedUntil: undefined,
      appSecret: undefined,
    })
    const serialized = serializeFromAccount(
      createPasskeyAccount(),
      [],
      [app],
      [],
    )
    const result = deserializeAccountStateSnapshot(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.connectedApps[0].appIcon).toBeUndefined()
    expect(result.data.connectedApps[0].appDescription).toBeUndefined()
    expect(result.data.connectedApps[0].connectedUntil).toBeUndefined()
  })

  it("should handle optional fields absent on postage stamp", () => {
    const stamp = createPostageStamp({ batchTTL: undefined })
    const serialized = serializeFromAccount(
      createPasskeyAccount(),
      [],
      [],
      [stamp],
    )
    const result = deserializeAccountStateSnapshot(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.postageStamps[0].batchTTL).toBeUndefined()
  })

  it("should handle optional defaultPostageStampBatchID absent on account metadata", () => {
    const account = createPasskeyAccount({
      defaultPostageStampBatchID: undefined,
    })
    const serialized = serializeFromAccount(account, [], [], [])
    const result = deserializeAccountStateSnapshot(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.metadata.defaultPostageStampBatchID).toBeUndefined()
  })

  it("should handle multiple entities of each type", () => {
    const account = createPasskeyAccount()
    const identities = [
      createIdentity({ id: "id-1", name: "Identity One" }),
      createIdentity({ id: "id-2", name: "Identity Two" }),
      createIdentity({ id: "id-3", name: "Identity Three" }),
    ]
    const connectedApps = [
      createConnectedApp({
        appUrl: "https://app1.example.com",
        identityId: "id-1",
      }),
      createConnectedApp({
        appUrl: "https://app2.example.com",
        identityId: "id-2",
      }),
    ]
    const postageStamps = [
      createPostageStamp({ batchID: new BatchId(TEST_BATCH_ID_HEX) }),
      createPostageStamp({ batchID: new BatchId(TEST_BATCH_ID_2_HEX) }),
    ]

    const serialized = serializeFromAccount(
      account,
      identities,
      connectedApps,
      postageStamps,
    )
    const result = deserializeAccountStateSnapshot(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.identities).toHaveLength(3)
    expect(result.data.connectedApps).toHaveLength(2)
    expect(result.data.postageStamps).toHaveLength(2)
  })
})

// ============================================================================
// Invalid Data Rejection
// ============================================================================

describe("invalid data rejection", () => {
  it("should reject wrong version number", () => {
    const serialized = serializeFromAccount(createPasskeyAccount(), [], [], [])
    const raw = JSON.parse(JSON.stringify(serialized))
    raw.version = 2

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject missing version", () => {
    const serialized = serializeFromAccount(createPasskeyAccount(), [], [], [])
    const raw = JSON.parse(JSON.stringify(serialized))
    delete raw.version

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject missing accountId", () => {
    const serialized = serializeFromAccount(createPasskeyAccount(), [], [], [])
    const raw = JSON.parse(JSON.stringify(serialized))
    delete raw.accountId

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject missing metadata", () => {
    const serialized = serializeFromAccount(createPasskeyAccount(), [], [], [])
    const raw = JSON.parse(JSON.stringify(serialized))
    delete raw.metadata

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject invalid accountId hex length", () => {
    const serialized = serializeFromAccount(createPasskeyAccount(), [], [], [])
    const raw = JSON.parse(JSON.stringify(serialized))
    raw.accountId = "abc" // too short

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject invalid BatchId hex length", () => {
    const raw = {
      version: 1,
      timestamp: Date.now(),
      accountId: TEST_ETH_ADDRESS_HEX,
      metadata: {
        accountName: "Test",
        createdAt: 1700000000000,
        lastModified: Date.now(),
      },
      identities: [],
      connectedApps: [],
      postageStamps: [
        {
          accountId: TEST_ETH_ADDRESS_HEX,
          batchID: "short",
          signerKey: TEST_PRIVATE_KEY_HEX,
          utilization: 0,
          usable: true,
          depth: 20,
          amount: 100000000,
          bucketDepth: 16,
          blockNumber: 12345678,
          immutableFlag: false,
          exists: true,
          createdAt: 1700000000000,
        },
      ],
    }

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject invalid PrivateKey hex length", () => {
    const raw = {
      version: 1,
      timestamp: Date.now(),
      accountId: TEST_ETH_ADDRESS_HEX,
      metadata: {
        accountName: "Test",
        createdAt: 1700000000000,
        lastModified: Date.now(),
      },
      identities: [],
      connectedApps: [],
      postageStamps: [
        {
          accountId: TEST_ETH_ADDRESS_HEX,
          batchID: TEST_BATCH_ID_HEX,
          signerKey: "short",
          utilization: 0,
          usable: true,
          depth: 20,
          amount: 100000000,
          bucketDepth: 16,
          blockNumber: 12345678,
          immutableFlag: false,
          exists: true,
          createdAt: 1700000000000,
        },
      ],
    }

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject number where string is expected", () => {
    const serialized = serializeFromAccount(createPasskeyAccount(), [], [], [])
    const raw = JSON.parse(JSON.stringify(serialized))
    raw.metadata.accountName = 12345

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject string where array is expected", () => {
    const serialized = serializeFromAccount(createPasskeyAccount(), [], [], [])
    const raw = JSON.parse(JSON.stringify(serialized))
    raw.identities = "not-an-array"

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject non-object input (string)", () => {
    const result = deserializeAccountStateSnapshot("not-an-object")
    expect(result.success).toBe(false)
  })

  it("should reject non-object input (number)", () => {
    const result = deserializeAccountStateSnapshot(42)
    expect(result.success).toBe(false)
  })

  it("should reject non-object input (undefined)", () => {
    const result = deserializeAccountStateSnapshot(undefined)
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// bee-js Type Conversions
// ============================================================================

describe("bee-js type conversions", () => {
  it("should convert hex strings to EthAddress instances in identities", () => {
    const raw = {
      version: 1,
      timestamp: Date.now(),
      accountId: TEST_ETH_ADDRESS_HEX,
      metadata: {
        accountName: "Test",
        createdAt: 1700000000000,
        lastModified: Date.now(),
      },
      identities: [
        {
          id: "id-1",
          accountId: TEST_ETH_ADDRESS_HEX,
          name: "Identity",
          createdAt: 1700000000000,
        },
      ],
      connectedApps: [],
      postageStamps: [],
    }

    const result = deserializeAccountStateSnapshot(raw)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.identities[0].accountId).toBeInstanceOf(EthAddress)
  })

  it("should convert hex strings to BatchId and PrivateKey instances", () => {
    const raw = {
      version: 1,
      timestamp: Date.now(),
      accountId: TEST_ETH_ADDRESS_HEX,
      metadata: {
        accountName: "Test",
        createdAt: 1700000000000,
        lastModified: Date.now(),
      },
      identities: [],
      connectedApps: [],
      postageStamps: [
        {
          accountId: TEST_ETH_ADDRESS_HEX,
          batchID: TEST_BATCH_ID_HEX,
          signerKey: TEST_PRIVATE_KEY_HEX,
          utilization: 0,
          usable: true,
          depth: 20,
          amount: 100000000,
          bucketDepth: 16,
          blockNumber: 12345678,
          immutableFlag: false,
          exists: true,
          createdAt: 1700000000000,
        },
      ],
    }

    const result = deserializeAccountStateSnapshot(raw)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.postageStamps[0].batchID).toBeInstanceOf(BatchId)
    expect(result.data.postageStamps[0].batchID.toHex()).toBe(TEST_BATCH_ID_HEX)
    expect(result.data.postageStamps[0].signerKey).toBeInstanceOf(PrivateKey)
    expect(result.data.postageStamps[0].signerKey.toHex()).toBe(
      TEST_PRIVATE_KEY_HEX,
    )
  })
})

// ============================================================================
// Schema Export
// ============================================================================

describe("AccountStateSnapshotSchemaV1", () => {
  it("should be exported and usable for direct validation", () => {
    expect(AccountStateSnapshotSchemaV1).toBeDefined()
    expect(typeof AccountStateSnapshotSchemaV1.safeParse).toBe("function")
  })
})

import { describe, it, expect } from "vitest"
import { EthAddress, BatchId, PrivateKey, Bytes } from "@ethersphere/bee-js"
import {
  serializeSwarmIdExport,
  deserializeSwarmIdExport,
  SwarmIdExportSchemaV1,
} from "./swarm-id-export"
import type { ConnectedApp, PostageStamp, EthereumAccount } from "../schemas"
import {
  TEST_ETH_ADDRESS_HEX,
  TEST_ETH_ADDRESS_2_HEX,
  TEST_BATCH_ID_HEX,
  TEST_BATCH_ID_2_HEX,
  TEST_PRIVATE_KEY_HEX,
  TEST_ENCRYPTION_KEY_HEX,
  createPasskeyAccount,
  createEthereumAccount,
  createAgentAccount,
  createIdentity,
  createConnectedApp,
  createPostageStamp,
} from "../test-fixtures"

// ============================================================================
// Round-trip Tests
// ============================================================================

describe("round-trip: serialize → JSON → deserialize", () => {
  it("should round-trip a passkey account with identities, apps, and stamps", () => {
    const account = createPasskeyAccount()
    const identities = [createIdentity()]
    const connectedApps = [createConnectedApp()]
    const postageStamps = [createPostageStamp()]

    const serialized = serializeSwarmIdExport(
      account,
      identities,
      connectedApps,
      postageStamps,
    )
    const json = JSON.stringify(serialized)
    const parsed = JSON.parse(json)
    const result = deserializeSwarmIdExport(parsed)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.account.type).toBe("passkey")
    expect(result.data.account.id).toBeInstanceOf(EthAddress)
    expect(result.data.account.id.toHex()).toBe(TEST_ETH_ADDRESS_HEX)
    expect(result.data.account.name).toBe("Test Passkey Account")
    expect(result.data.identities).toHaveLength(1)
    expect(result.data.identities[0].accountId).toBeInstanceOf(EthAddress)
    expect(result.data.connectedApps).toHaveLength(1)
    expect(result.data.connectedApps[0].appName).toBe("Test App")
    expect(result.data.postageStamps).toHaveLength(1)
    expect(result.data.postageStamps[0].batchID).toBeInstanceOf(BatchId)
    expect(result.data.postageStamps[0].signerKey).toBeInstanceOf(PrivateKey)
  })

  it("should round-trip an ethereum account with Bytes fields", () => {
    const account = createEthereumAccount()
    const identities = [createIdentity()]
    const connectedApps: ConnectedApp[] = []
    const postageStamps: PostageStamp[] = []

    const serialized = serializeSwarmIdExport(
      account,
      identities,
      connectedApps,
      postageStamps,
    )
    const json = JSON.stringify(serialized)
    const parsed = JSON.parse(json)
    const result = deserializeSwarmIdExport(parsed)

    expect(result.success).toBe(true)
    if (!result.success) return

    const ethAccount = result.data.account as EthereumAccount
    expect(ethAccount.type).toBe("ethereum")
    expect(ethAccount.ethereumAddress).toBeInstanceOf(EthAddress)
    expect(ethAccount.encryptedMasterKey).toBeInstanceOf(Bytes)
    expect(ethAccount.encryptionSalt).toBeInstanceOf(Bytes)
    expect(ethAccount.encryptedSecretSeed).toBeInstanceOf(Bytes)
    expect(Array.from(ethAccount.encryptedMasterKey.toUint8Array())).toEqual([
      1, 2, 3, 4,
    ])
    expect(Array.from(ethAccount.encryptionSalt.toUint8Array())).toEqual([
      5, 6, 7, 8,
    ])
    expect(Array.from(ethAccount.encryptedSecretSeed.toUint8Array())).toEqual([
      9, 10, 11, 12,
    ])
  })

  it("should round-trip an agent account", () => {
    const account = createAgentAccount()
    const identities = [createIdentity()]
    const connectedApps: ConnectedApp[] = []
    const postageStamps: PostageStamp[] = []

    const serialized = serializeSwarmIdExport(
      account,
      identities,
      connectedApps,
      postageStamps,
    )
    const json = JSON.stringify(serialized)
    const parsed = JSON.parse(json)
    const result = deserializeSwarmIdExport(parsed)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.account.type).toBe("agent")
    expect(result.data.account.name).toBe("Test Agent Account")
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

    const serialized = serializeSwarmIdExport(
      account,
      identities,
      connectedApps,
      postageStamps,
    )

    // Simulate file write + read
    const fileContent = JSON.stringify(serialized, undefined, 2)
    const fileData = JSON.parse(fileContent)
    const result = deserializeSwarmIdExport(fileData)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.account.defaultPostageStampBatchID).toBeInstanceOf(
      BatchId,
    )
    expect(result.data.identities[0].settings?.appSessionDuration).toBe(3600)
    expect(result.data.connectedApps[0].appIcon).toBe(
      "https://example.com/icon.png",
    )
    expect(result.data.postageStamps[0].batchTTL).toBe(86400)
  })
})

// ============================================================================
// appSecret Security Tests
// ============================================================================

describe("appSecret security", () => {
  it("should strip appSecret from serialized export even when present on input", () => {
    const account = createPasskeyAccount()
    const connectedApps = [createConnectedApp({ appSecret: "my-secret-value" })]

    const serialized = serializeSwarmIdExport(account, [], connectedApps, [])

    // Verify appSecret is not in the serialized output
    const apps = serialized.connectedApps as Record<string, unknown>[]
    expect(apps[0]).not.toHaveProperty("appSecret")
  })

  it("should strip injected appSecret during import", () => {
    const account = createPasskeyAccount()
    const serialized = serializeSwarmIdExport(account, [], [], [])

    // Maliciously inject appSecret into raw data
    const raw = JSON.parse(JSON.stringify(serialized))
    raw.connectedApps = [
      {
        appUrl: "https://evil.example.com",
        appName: "Evil App",
        lastConnectedAt: 1700000000000,
        identityId: "identity-1",
        appSecret: "injected-secret",
      },
    ]

    const result = deserializeSwarmIdExport(raw)

    expect(result.success).toBe(true)
    if (!result.success) return

    // The imported app should not have appSecret
    const importedApp = result.data.connectedApps[0] as Record<string, unknown>
    expect(importedApp).not.toHaveProperty("appSecret")
  })
})

// ============================================================================
// Edge Cases
// ============================================================================

describe("edge cases", () => {
  it("should handle empty arrays for identities, connectedApps, and postageStamps", () => {
    const account = createPasskeyAccount()
    const serialized = serializeSwarmIdExport(account, [], [], [])
    const result = deserializeSwarmIdExport(
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
    const serialized = serializeSwarmIdExport(
      createPasskeyAccount(),
      [identity],
      [],
      [],
    )
    const result = deserializeSwarmIdExport(
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
    const serialized = serializeSwarmIdExport(
      createPasskeyAccount(),
      [],
      [app],
      [],
    )
    const result = deserializeSwarmIdExport(
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
    const serialized = serializeSwarmIdExport(
      createPasskeyAccount(),
      [],
      [],
      [stamp],
    )
    const result = deserializeSwarmIdExport(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.postageStamps[0].batchTTL).toBeUndefined()
  })

  it("should handle optional defaultPostageStampBatchID absent on account", () => {
    const account = createPasskeyAccount({
      defaultPostageStampBatchID: undefined,
    })
    const serialized = serializeSwarmIdExport(account, [], [], [])
    const result = deserializeSwarmIdExport(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.account.defaultPostageStampBatchID).toBeUndefined()
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

    const serialized = serializeSwarmIdExport(
      account,
      identities,
      connectedApps,
      postageStamps,
    )
    const result = deserializeSwarmIdExport(
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
    const serialized = serializeSwarmIdExport(
      createPasskeyAccount(),
      [],
      [],
      [],
    )
    const raw = JSON.parse(JSON.stringify(serialized))
    raw.version = 2

    const result = deserializeSwarmIdExport(raw)
    expect(result.success).toBe(false)
  })

  it("should reject missing version", () => {
    const serialized = serializeSwarmIdExport(
      createPasskeyAccount(),
      [],
      [],
      [],
    )
    const raw = JSON.parse(JSON.stringify(serialized))
    delete raw.version

    const result = deserializeSwarmIdExport(raw)
    expect(result.success).toBe(false)
  })

  it("should reject missing account", () => {
    const serialized = serializeSwarmIdExport(
      createPasskeyAccount(),
      [],
      [],
      [],
    )
    const raw = JSON.parse(JSON.stringify(serialized))
    delete raw.account

    const result = deserializeSwarmIdExport(raw)
    expect(result.success).toBe(false)
  })

  it("should reject invalid account type", () => {
    const serialized = serializeSwarmIdExport(
      createPasskeyAccount(),
      [],
      [],
      [],
    )
    const raw = JSON.parse(JSON.stringify(serialized))
    raw.account.type = "invalid"

    const result = deserializeSwarmIdExport(raw)
    expect(result.success).toBe(false)
  })

  it("should reject invalid EthAddress hex length", () => {
    const serialized = serializeSwarmIdExport(
      createPasskeyAccount(),
      [],
      [],
      [],
    )
    const raw = JSON.parse(JSON.stringify(serialized))
    raw.account.id = "abc" // too short

    const result = deserializeSwarmIdExport(raw)
    expect(result.success).toBe(false)
  })

  it("should reject invalid BatchId hex length", () => {
    const raw = {
      version: 1,
      account: {
        id: TEST_ETH_ADDRESS_HEX,
        name: "Test",
        createdAt: 1700000000000,
        type: "passkey",
        credentialId: "cred",
        swarmEncryptionKey: TEST_ENCRYPTION_KEY_HEX,
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

    const result = deserializeSwarmIdExport(raw)
    expect(result.success).toBe(false)
  })

  it("should reject invalid PrivateKey hex length", () => {
    const raw = {
      version: 1,
      account: {
        id: TEST_ETH_ADDRESS_HEX,
        name: "Test",
        createdAt: 1700000000000,
        type: "passkey",
        credentialId: "cred",
        swarmEncryptionKey: TEST_ENCRYPTION_KEY_HEX,
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

    const result = deserializeSwarmIdExport(raw)
    expect(result.success).toBe(false)
  })

  it("should reject number where string is expected", () => {
    const serialized = serializeSwarmIdExport(
      createPasskeyAccount(),
      [],
      [],
      [],
    )
    const raw = JSON.parse(JSON.stringify(serialized))
    raw.account.name = 12345

    const result = deserializeSwarmIdExport(raw)
    expect(result.success).toBe(false)
  })

  it("should reject string where array is expected", () => {
    const serialized = serializeSwarmIdExport(
      createPasskeyAccount(),
      [],
      [],
      [],
    )
    const raw = JSON.parse(JSON.stringify(serialized))
    raw.identities = "not-an-array"

    const result = deserializeSwarmIdExport(raw)
    expect(result.success).toBe(false)
  })

  it("should reject non-object input (string)", () => {
    const result = deserializeSwarmIdExport("not-an-object")
    expect(result.success).toBe(false)
  })

  it("should reject non-object input (number)", () => {
    const result = deserializeSwarmIdExport(42)
    expect(result.success).toBe(false)
  })

  it("should reject non-object input (undefined)", () => {
    const result = deserializeSwarmIdExport(undefined)
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// bee-js Type Conversions
// ============================================================================

describe("bee-js type conversions", () => {
  it("should convert hex strings to EthAddress instances", () => {
    const raw = {
      version: 1,
      account: {
        id: TEST_ETH_ADDRESS_HEX,
        name: "Test",
        createdAt: 1700000000000,
        type: "passkey",
        credentialId: "cred",
        swarmEncryptionKey: TEST_ENCRYPTION_KEY_HEX,
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

    const result = deserializeSwarmIdExport(raw)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.account.id).toBeInstanceOf(EthAddress)
    expect(result.data.account.id.toHex()).toBe(TEST_ETH_ADDRESS_HEX)
    expect(result.data.identities[0].accountId).toBeInstanceOf(EthAddress)
  })

  it("should convert hex strings to BatchId and PrivateKey instances", () => {
    const raw = {
      version: 1,
      account: {
        id: TEST_ETH_ADDRESS_HEX,
        name: "Test",
        createdAt: 1700000000000,
        type: "passkey",
        credentialId: "cred",
        swarmEncryptionKey: TEST_ENCRYPTION_KEY_HEX,
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

    const result = deserializeSwarmIdExport(raw)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.postageStamps[0].batchID).toBeInstanceOf(BatchId)
    expect(result.data.postageStamps[0].batchID.toHex()).toBe(TEST_BATCH_ID_HEX)
    expect(result.data.postageStamps[0].signerKey).toBeInstanceOf(PrivateKey)
    expect(result.data.postageStamps[0].signerKey.toHex()).toBe(
      TEST_PRIVATE_KEY_HEX,
    )
  })

  it("should convert number arrays to Bytes instances for Ethereum accounts", () => {
    const raw = {
      version: 1,
      account: {
        id: TEST_ETH_ADDRESS_HEX,
        name: "Test Eth",
        createdAt: 1700000000000,
        type: "ethereum",
        ethereumAddress: TEST_ETH_ADDRESS_2_HEX,
        encryptedMasterKey: [10, 20, 30],
        encryptionSalt: [40, 50, 60],
        encryptedSecretSeed: [70, 80, 90],
        swarmEncryptionKey: TEST_ENCRYPTION_KEY_HEX,
      },
      identities: [],
      connectedApps: [],
      postageStamps: [],
    }

    const result = deserializeSwarmIdExport(raw)

    expect(result.success).toBe(true)
    if (!result.success) return

    const ethAccount = result.data.account as EthereumAccount
    expect(ethAccount.encryptedMasterKey).toBeInstanceOf(Bytes)
    expect(ethAccount.encryptionSalt).toBeInstanceOf(Bytes)
    expect(ethAccount.encryptedSecretSeed).toBeInstanceOf(Bytes)
    expect(Array.from(ethAccount.encryptedMasterKey.toUint8Array())).toEqual([
      10, 20, 30,
    ])
    expect(Array.from(ethAccount.encryptionSalt.toUint8Array())).toEqual([
      40, 50, 60,
    ])
    expect(Array.from(ethAccount.encryptedSecretSeed.toUint8Array())).toEqual([
      70, 80, 90,
    ])
  })
})

// ============================================================================
// Schema Export
// ============================================================================

describe("SwarmIdExportSchemaV1", () => {
  it("should be exported and usable for direct validation", () => {
    expect(SwarmIdExportSchemaV1).toBeDefined()
    expect(typeof SwarmIdExportSchemaV1.safeParse).toBe("function")
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId, PrivateKey } from "@ethersphere/bee-js"
import {
  serializeAccountStateSnapshot,
  deserializeAccountStateSnapshot,
  AccountStateSnapshotSchemaV1,
} from "./account-state-snapshot"
import type { Account } from "../schemas"
import {
  TEST_ETH_ADDRESS_HEX,
  TEST_BATCH_ID_HEX,
  TEST_BATCH_ID_2_HEX,
  TEST_PRIVATE_KEY_HEX,
  createPasskeyAccount,
  createEthereumAccount,
  createAgentAccount,
  createConnectedApp,
  createPostageStamp,
  createDevice,
} from "../test-fixtures"

/**
 * Helper: build a snapshot from a nested account (apps + stamps are read off
 * the account; the wire snapshot strips secrets).
 */
function serializeFromAccount(account: Account) {
  return serializeAccountStateSnapshot({
    accountId: account.id.toHex(),
    metadata: {
      accountName: account.name,
      defaultPostageStampBatchID: account.defaultPostageStampBatchID?.toHex(),
      publicKey: account.publicKey,
      settings: account.settings,
      createdAt: account.createdAt,
      lastModified: Date.now(),
      devices: account.devices,
    },
    connectedApps: account.connectedApps,
    postageStamps: account.postageStamps,
    timestamp: Date.now(),
  })
}

// ============================================================================
// Round-trip Tests
// ============================================================================

describe("round-trip: serialize → JSON → deserialize", () => {
  it("should round-trip a passkey account with apps and stamps", () => {
    const account = createPasskeyAccount({
      connectedApps: [createConnectedApp()],
      postageStamps: [createPostageStamp()],
    })

    const serialized = serializeFromAccount(account)
    const json = JSON.stringify(serialized)
    const parsed = JSON.parse(json)
    const result = deserializeAccountStateSnapshot(parsed)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.accountId).toBe(TEST_ETH_ADDRESS_HEX)
    expect(result.data.metadata.accountName).toBe("Test Passkey Account")
    expect(result.data.connectedApps).toHaveLength(1)
    expect(result.data.connectedApps[0].appName).toBe("Test App")
    expect(result.data.postageStamps).toHaveLength(1)
    expect(result.data.postageStamps[0].batchID).toBeInstanceOf(BatchId)
    expect(result.data.postageStamps[0].signerKey).toBeInstanceOf(PrivateKey)
  })

  it("should round-trip an ethereum account with metadata", () => {
    const account = createEthereumAccount()

    const serialized = serializeFromAccount(account)
    const result = deserializeAccountStateSnapshot(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.accountId).toBe(TEST_ETH_ADDRESS_HEX)
    expect(result.data.metadata.accountName).toBe("Test Ethereum Account")
    expect(result.data.metadata.createdAt).toBe(1700000000000)
  })

  it("should round-trip an agent account", () => {
    const account = createAgentAccount()

    const serialized = serializeFromAccount(account)
    const result = deserializeAccountStateSnapshot(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.metadata.accountName).toBe("Test Agent Account")
  })

  it("should produce valid JSON for actual file I/O simulation", () => {
    const account = createPasskeyAccount({
      defaultPostageStampBatchID: new BatchId(TEST_BATCH_ID_HEX),
      settings: { appSessionDuration: 3600 },
      connectedApps: [
        createConnectedApp({
          appIcon: "https://example.com/icon.png",
          appDescription: "A test app",
          connectedUntil: 1700100000000,
        }),
      ],
      postageStamps: [createPostageStamp({ batchTTL: 86400 })],
    })

    const serialized = serializeFromAccount(account)

    // Simulate file write + read
    const fileContent = JSON.stringify(serialized, undefined, 2)
    const fileData = JSON.parse(fileContent)
    const result = deserializeAccountStateSnapshot(fileData)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.metadata.defaultPostageStampBatchID).toBe(
      TEST_BATCH_ID_HEX,
    )
    expect(result.data.metadata.settings?.appSessionDuration).toBe(3600)
    expect(result.data.connectedApps[0].appIcon).toBe(
      "https://example.com/icon.png",
    )
    expect(result.data.postageStamps[0].batchTTL).toBe(86400)
  })
})

// ============================================================================
// Device Tracking Tests
// ============================================================================

describe("device tracking in metadata", () => {
  it("should round-trip devices through metadata", () => {
    const device = createDevice()
    const account = createPasskeyAccount({ devices: [device] })
    const serialized = serializeFromAccount(account)
    const result = deserializeAccountStateSnapshot(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.metadata.devices).toHaveLength(1)
    expect(result.data.metadata.devices[0].deviceId).toBe(device.deviceId)
    expect(result.data.metadata.devices[0].createdAt).toBe(device.createdAt)
    expect(result.data.metadata.devices[0].lastSignedInAt).toBe(
      device.lastSignedInAt,
    )
  })

  it("should default to empty array when devices are absent", () => {
    const raw = {
      version: 1,
      timestamp: Date.now(),
      accountId: TEST_ETH_ADDRESS_HEX,
      metadata: {
        accountName: "Test",
        createdAt: 1700000000000,
        lastModified: Date.now(),
      },
      connectedApps: [],
      postageStamps: [],
    }

    const result = deserializeAccountStateSnapshot(raw)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.metadata.devices).toEqual([])
  })
})

// ============================================================================
// appSecret Persistence Tests
// ============================================================================

describe("appSecret in snapshots", () => {
  it("should include appSecret in serialized export when present on input", () => {
    const account = createPasskeyAccount({
      connectedApps: [createConnectedApp({ appSecret: "my-secret-value" })],
    })

    const serialized = serializeFromAccount(account)

    const apps = serialized.connectedApps as Record<string, unknown>[]
    expect(apps[0]).toHaveProperty("appSecret", "my-secret-value")
  })

  it("should preserve appSecret through round-trip", () => {
    const account = createPasskeyAccount()
    const serialized = serializeFromAccount(account)

    const raw = JSON.parse(JSON.stringify(serialized))
    raw.connectedApps = [
      {
        appUrl: "https://example.com",
        appName: "Test App",
        lastConnectedAt: 1700000000000,
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
  it("should handle empty arrays for connectedApps and postageStamps", () => {
    const account = createPasskeyAccount()
    const serialized = serializeFromAccount(account)
    const result = deserializeAccountStateSnapshot(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.connectedApps).toEqual([])
    expect(result.data.postageStamps).toEqual([])
  })

  it("should handle account settings absent", () => {
    const account = createPasskeyAccount({ settings: undefined })
    const serialized = serializeFromAccount(account)
    const result = deserializeAccountStateSnapshot(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.metadata.settings).toBeUndefined()
  })

  it("should handle optional fields absent on connected app", () => {
    const app = createConnectedApp({
      appIcon: undefined,
      appDescription: undefined,
      connectedUntil: undefined,
      appSecret: undefined,
    })
    const serialized = serializeFromAccount(
      createPasskeyAccount({ connectedApps: [app] }),
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
      createPasskeyAccount({ postageStamps: [stamp] }),
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
    const serialized = serializeFromAccount(account)
    const result = deserializeAccountStateSnapshot(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.metadata.defaultPostageStampBatchID).toBeUndefined()
  })

  it("should handle multiple entities of each type", () => {
    const account = createPasskeyAccount({
      connectedApps: [
        createConnectedApp({ appUrl: "https://app1.example.com" }),
        createConnectedApp({ appUrl: "https://app2.example.com" }),
      ],
      postageStamps: [
        createPostageStamp({ batchID: new BatchId(TEST_BATCH_ID_HEX) }),
        createPostageStamp({ batchID: new BatchId(TEST_BATCH_ID_2_HEX) }),
      ],
    })

    const serialized = serializeFromAccount(account)
    const result = deserializeAccountStateSnapshot(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.connectedApps).toHaveLength(2)
    expect(result.data.postageStamps).toHaveLength(2)
  })
})

// ============================================================================
// Invalid Data Rejection
// ============================================================================

describe("invalid data rejection", () => {
  it("should reject wrong version number", () => {
    const serialized = serializeFromAccount(createPasskeyAccount())
    const raw = JSON.parse(JSON.stringify(serialized))
    raw.version = 2

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject missing version", () => {
    const serialized = serializeFromAccount(createPasskeyAccount())
    const raw = JSON.parse(JSON.stringify(serialized))
    delete raw.version

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject missing accountId", () => {
    const serialized = serializeFromAccount(createPasskeyAccount())
    const raw = JSON.parse(JSON.stringify(serialized))
    delete raw.accountId

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject missing metadata", () => {
    const serialized = serializeFromAccount(createPasskeyAccount())
    const raw = JSON.parse(JSON.stringify(serialized))
    delete raw.metadata

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject invalid accountId hex length", () => {
    const serialized = serializeFromAccount(createPasskeyAccount())
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
      connectedApps: [],
      postageStamps: [
        {
          batchID: "short",
          signerKey: TEST_PRIVATE_KEY_HEX,
          utilization: 0,
          usable: true,
          depth: 20,
          amount: "100000000",
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
      connectedApps: [],
      postageStamps: [
        {
          batchID: TEST_BATCH_ID_HEX,
          signerKey: "short",
          utilization: 0,
          usable: true,
          depth: 20,
          amount: "100000000",
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
    const serialized = serializeFromAccount(createPasskeyAccount())
    const raw = JSON.parse(JSON.stringify(serialized))
    raw.metadata.accountName = 12345

    const result = deserializeAccountStateSnapshot(raw)
    expect(result.success).toBe(false)
  })

  it("should reject string where array is expected", () => {
    const serialized = serializeFromAccount(createPasskeyAccount())
    const raw = JSON.parse(JSON.stringify(serialized))
    raw.connectedApps = "not-an-array"

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
      connectedApps: [],
      postageStamps: [
        {
          batchID: TEST_BATCH_ID_HEX,
          signerKey: TEST_PRIVATE_KEY_HEX,
          utilization: 0,
          usable: true,
          depth: 20,
          amount: "100000000",
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

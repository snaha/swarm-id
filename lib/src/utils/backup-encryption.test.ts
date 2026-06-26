// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId } from "@ethersphere/bee-js"
import {
  deriveBackupEncryptionKey,
  encryptBackupPayload,
  decryptBackupPayload,
  buildBackupHeader,
  createEncryptedExport,
  decryptEncryptedExport,
  parseEncryptedExportHeader,
  EncryptedSwarmIdExportSchemaV1,
} from "./backup-encryption"
import {
  TEST_ETH_ADDRESS_HEX,
  TEST_DERIVATION_KEY_HEX,
  DIFFERENT_DERIVATION_KEY_HEX,
  createAccount,
  createConnectedApp,
  createPostageStamp,
} from "../test-fixtures"

// ============================================================================
// Round-trip Tests
// ============================================================================

describe("round-trip: encrypt → decrypt", () => {
  it("should round-trip an account, exporting no key or seed-vault material", async () => {
    const account = createAccount({
      access: { type: "passkey", credentialId: "cred-xyz" },
      encryptedSeed: "deadbeef",
      connectedApps: [createConnectedApp()],
      postageStamps: [createPostageStamp()],
    })

    const encrypted = await createEncryptedExport(
      account,
      TEST_DERIVATION_KEY_HEX,
    )

    expect(typeof encrypted.ciphertext).toBe("string")
    // No account-type discriminant, no key material, no plaintext account data,
    // and never the device-local seed vault in the outer (plaintext) object.
    expect(encrypted).not.toHaveProperty("accountType")
    expect(encrypted).not.toHaveProperty("credentialId")
    expect(encrypted).not.toHaveProperty("access")
    expect(encrypted).not.toHaveProperty("encryptedSeed")
    expect(encrypted).not.toHaveProperty("account")
    expect(encrypted).not.toHaveProperty("postageStamps")

    const result = await decryptEncryptedExport(
      encrypted,
      TEST_DERIVATION_KEY_HEX,
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.accountId).toBe(TEST_ETH_ADDRESS_HEX)
    expect(result.data.metadata.accountName).toBe("Test Account")
    expect(result.data.connectedApps).toHaveLength(1)
    expect(result.data.postageStamps).toHaveLength(1)
    expect(result.data.postageStamps[0].batchID).toBeInstanceOf(BatchId)
  })

  it("should survive JSON serialization (file I/O simulation)", async () => {
    const account = createAccount({
      defaultPostageStampBatchID: new BatchId("c".repeat(64)),
      settings: { appSessionDuration: 3600 },
      connectedApps: [createConnectedApp()],
      postageStamps: [createPostageStamp({ batchTTL: 86400 })],
    })

    const encrypted = await createEncryptedExport(
      account,
      TEST_DERIVATION_KEY_HEX,
    )

    // Simulate file write + read
    const fileContent = JSON.stringify(encrypted, undefined, 2)
    const fileData = JSON.parse(fileContent)

    const result = await decryptEncryptedExport(
      fileData,
      TEST_DERIVATION_KEY_HEX,
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.metadata.defaultPostageStampBatchID).toBe("c".repeat(64))
    expect(result.data.metadata.settings?.appSessionDuration).toBe(3600)
    expect(result.data.postageStamps[0].batchTTL).toBe(86400)
  })
})

// ============================================================================
// appSecret Security Tests
// ============================================================================

describe("appSecret preservation in encrypted export", () => {
  it("should preserve appSecret in connected apps through encrypted export", async () => {
    const account = createAccount({
      connectedApps: [createConnectedApp({ appSecret: "my-secret-value" })],
    })

    const encrypted = await createEncryptedExport(
      account,
      TEST_DERIVATION_KEY_HEX,
    )

    const result = await decryptEncryptedExport(
      encrypted,
      TEST_DERIVATION_KEY_HEX,
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.connectedApps[0].appSecret).toBe("my-secret-value")
  })
})

// ============================================================================
// Key Derivation Tests
// ============================================================================

describe("key derivation determinism", () => {
  it("should derive the same CryptoKey from the same swarmEncryptionKey", async () => {
    const key1 = await deriveBackupEncryptionKey(TEST_DERIVATION_KEY_HEX)
    const key2 = await deriveBackupEncryptionKey(TEST_DERIVATION_KEY_HEX)

    // Verify determinism: encrypt with key1, decrypt with key2
    const plaintext = '{"determinism":"test"}'
    const ciphertext = await encryptBackupPayload(plaintext, key1)
    const decrypted = await decryptBackupPayload(ciphertext, key2)

    expect(decrypted).toBe(plaintext)
  })

  it("should derive different keys from different swarmEncryptionKeys", async () => {
    const key1 = await deriveBackupEncryptionKey(TEST_DERIVATION_KEY_HEX)
    const key2 = await deriveBackupEncryptionKey(DIFFERENT_DERIVATION_KEY_HEX)

    // Encrypt with key1, should fail to decrypt with key2
    const ciphertext = await encryptBackupPayload('{"test":true}', key1)
    await expect(decryptBackupPayload(ciphertext, key2)).rejects.toThrow()
  })
})

// ============================================================================
// Wrong Key Rejection
// ============================================================================

describe("wrong key rejection", () => {
  it("should fail to decrypt with a different swarmEncryptionKey", async () => {
    const account = createAccount()

    const encrypted = await createEncryptedExport(
      account,
      TEST_DERIVATION_KEY_HEX,
    )

    const result = await decryptEncryptedExport(
      encrypted,
      DIFFERENT_DERIVATION_KEY_HEX,
    )

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0].message).toContain("Decryption failed")
  })

  it("should fail at the payload level with wrong key", async () => {
    const correctKey = await deriveBackupEncryptionKey(TEST_DERIVATION_KEY_HEX)
    const wrongKey = await deriveBackupEncryptionKey(
      DIFFERENT_DERIVATION_KEY_HEX,
    )

    const ciphertext = await encryptBackupPayload('{"test": true}', correctKey)

    await expect(decryptBackupPayload(ciphertext, wrongKey)).rejects.toThrow()
  })
})

// ============================================================================
// Header Construction Tests
// ============================================================================

describe("buildBackupHeader", () => {
  it("carries only plaintext metadata — no type, key, or seed-vault material", () => {
    const header = buildBackupHeader(
      createAccount({
        access: { type: "passkey", credentialId: "cred-xyz" },
        encryptedSeed: "deadbeef",
      }),
    )

    expect(header.version).toBe(1)
    expect(header.accountName).toBe("Test Account")
    expect(typeof header.exportedAt).toBe("number")
    // No account-type discriminant, no key material, no device-local seed vault.
    expect(header).not.toHaveProperty("accountType")
    expect(header).not.toHaveProperty("credentialId")
    expect(header).not.toHaveProperty("ethereumAddress")
    expect(header).not.toHaveProperty("access")
    expect(header).not.toHaveProperty("encryptedSeed")
  })
})

// ============================================================================
// Schema Validation Tests
// ============================================================================

describe("schema validation", () => {
  it("should accept a valid encrypted export", async () => {
    const encrypted = await createEncryptedExport(
      createAccount(),
      TEST_DERIVATION_KEY_HEX,
    )

    const result = EncryptedSwarmIdExportSchemaV1.safeParse(encrypted)
    expect(result.success).toBe(true)
  })

  it("should reject missing ciphertext", () => {
    const result = EncryptedSwarmIdExportSchemaV1.safeParse({
      version: 1,
      accountName: "Test",
      exportedAt: Date.now(),
      // missing ciphertext
    })
    expect(result.success).toBe(false)
  })

  it("should reject wrong version number", () => {
    const result = EncryptedSwarmIdExportSchemaV1.safeParse({
      version: 2,
      accountName: "Test",
      exportedAt: Date.now(),
      ciphertext: "abc",
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// parseEncryptedExportHeader Tests
// ============================================================================

describe("parseEncryptedExportHeader", () => {
  it("should parse a valid header", async () => {
    const encrypted = await createEncryptedExport(
      createAccount(),
      TEST_DERIVATION_KEY_HEX,
    )

    const result = parseEncryptedExportHeader(encrypted)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.header.accountName).toBe("Test Account")
  })

  it("should reject non-object input (string)", () => {
    const result = parseEncryptedExportHeader("not-an-object")
    expect(result.success).toBe(false)
  })

  it("should reject non-object input (number)", () => {
    const result = parseEncryptedExportHeader(42)
    expect(result.success).toBe(false)
  })

  it("should reject non-object input (undefined)", () => {
    const result = parseEncryptedExportHeader(undefined)
    expect(result.success).toBe(false)
  })

  it("should reject null input", () => {
    const result = parseEncryptedExportHeader(null)
    expect(result.success).toBe(false)
  })

  it("should reject empty object", () => {
    const result = parseEncryptedExportHeader({})
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// Encrypt/Decrypt Payload Directly
// ============================================================================

describe("encryptBackupPayload / decryptBackupPayload", () => {
  it("should encrypt and decrypt a payload", async () => {
    const key = await deriveBackupEncryptionKey(TEST_DERIVATION_KEY_HEX)
    const plaintext = '{"hello":"world"}'

    const ciphertext = await encryptBackupPayload(plaintext, key)
    expect(typeof ciphertext).toBe("string")
    expect(ciphertext).not.toBe(plaintext)

    const decrypted = await decryptBackupPayload(ciphertext, key)
    expect(decrypted).toBe(plaintext)
  })

  it("should produce different ciphertext for same input (random IV)", async () => {
    const key = await deriveBackupEncryptionKey(TEST_DERIVATION_KEY_HEX)
    const plaintext = '{"test":true}'

    const ct1 = await encryptBackupPayload(plaintext, key)
    const ct2 = await encryptBackupPayload(plaintext, key)

    expect(ct1).not.toBe(ct2)
  })
})

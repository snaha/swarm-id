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
  TEST_ETH_ADDRESS_2_HEX,
  TEST_ENCRYPTION_KEY_HEX,
  DIFFERENT_ENCRYPTION_KEY_HEX,
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

describe("round-trip: encrypt → decrypt for each account type", () => {
  it("should round-trip a passkey account", async () => {
    const account = createPasskeyAccount()
    const identities = [createIdentity()]
    const connectedApps = [createConnectedApp()]
    const postageStamps = [createPostageStamp()]

    const encrypted = await createEncryptedExport(
      account,
      identities,
      connectedApps,
      postageStamps,
      account.swarmEncryptionKey,
    )

    expect(encrypted.accountType).toBe("passkey")
    expect(encrypted.credentialId).toBe("credential-abc-123")
    expect(typeof encrypted.ciphertext).toBe("string")
    // No plaintext account data in the outer object
    expect(encrypted).not.toHaveProperty("account")
    expect(encrypted).not.toHaveProperty("identities")
    expect(encrypted).not.toHaveProperty("postageStamps")

    const result = await decryptEncryptedExport(
      encrypted,
      account.swarmEncryptionKey,
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.accountId).toBe(TEST_ETH_ADDRESS_HEX)
    expect(result.data.metadata.accountName).toBe("Test Passkey Account")
    expect(result.data.identities).toHaveLength(1)
    expect(result.data.connectedApps).toHaveLength(1)
    expect(result.data.postageStamps).toHaveLength(1)
    expect(result.data.postageStamps[0].batchID).toBeInstanceOf(BatchId)
  })

  it("should round-trip an ethereum account", async () => {
    const account = createEthereumAccount()
    const identities = [createIdentity()]

    const encrypted = await createEncryptedExport(
      account,
      identities,
      [],
      [],
      account.swarmEncryptionKey,
    )

    expect(encrypted.accountType).toBe("ethereum")
    expect(encrypted.ethereumAddress).toBe(TEST_ETH_ADDRESS_2_HEX)

    const result = await decryptEncryptedExport(
      encrypted,
      account.swarmEncryptionKey,
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.accountId).toBe(TEST_ETH_ADDRESS_HEX)
    expect(result.data.metadata.accountName).toBe("Test Ethereum Account")
  })

  it("should round-trip an agent account", async () => {
    const account = createAgentAccount()
    const identities = [createIdentity()]

    const encrypted = await createEncryptedExport(
      account,
      identities,
      [],
      [],
      account.swarmEncryptionKey,
    )

    expect(encrypted.accountType).toBe("agent")

    const result = await decryptEncryptedExport(
      encrypted,
      account.swarmEncryptionKey,
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.metadata.accountName).toBe("Test Agent Account")
  })

  it("should survive JSON serialization (file I/O simulation)", async () => {
    const account = createPasskeyAccount({
      defaultPostageStampBatchID: new BatchId("c".repeat(64)),
    })
    const identities = [
      createIdentity({ settings: { appSessionDuration: 3600 } }),
    ]
    const connectedApps = [createConnectedApp()]
    const postageStamps = [createPostageStamp({ batchTTL: 86400 })]

    const encrypted = await createEncryptedExport(
      account,
      identities,
      connectedApps,
      postageStamps,
      account.swarmEncryptionKey,
    )

    // Simulate file write + read
    const fileContent = JSON.stringify(encrypted, undefined, 2)
    const fileData = JSON.parse(fileContent)

    const result = await decryptEncryptedExport(
      fileData,
      account.swarmEncryptionKey,
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.metadata.defaultPostageStampBatchID).toBe("c".repeat(64))
    expect(result.data.identities[0].settings?.appSessionDuration).toBe(3600)
    expect(result.data.postageStamps[0].batchTTL).toBe(86400)
  })
})

// ============================================================================
// appSecret Security Tests
// ============================================================================

describe("appSecret preservation in encrypted export", () => {
  it("should preserve appSecret in connected apps through encrypted export", async () => {
    const account = createPasskeyAccount()
    const connectedApps = [createConnectedApp({ appSecret: "my-secret-value" })]

    const encrypted = await createEncryptedExport(
      account,
      [],
      connectedApps,
      [],
      account.swarmEncryptionKey,
    )

    const result = await decryptEncryptedExport(
      encrypted,
      account.swarmEncryptionKey,
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
    const key1 = await deriveBackupEncryptionKey(TEST_ENCRYPTION_KEY_HEX)
    const key2 = await deriveBackupEncryptionKey(TEST_ENCRYPTION_KEY_HEX)

    // Verify determinism: encrypt with key1, decrypt with key2
    const plaintext = '{"determinism":"test"}'
    const ciphertext = await encryptBackupPayload(plaintext, key1)
    const decrypted = await decryptBackupPayload(ciphertext, key2)

    expect(decrypted).toBe(plaintext)
  })

  it("should derive different keys from different swarmEncryptionKeys", async () => {
    const key1 = await deriveBackupEncryptionKey(TEST_ENCRYPTION_KEY_HEX)
    const key2 = await deriveBackupEncryptionKey(DIFFERENT_ENCRYPTION_KEY_HEX)

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
    const account = createPasskeyAccount()

    const encrypted = await createEncryptedExport(
      account,
      [createIdentity()],
      [],
      [],
      account.swarmEncryptionKey,
    )

    const result = await decryptEncryptedExport(
      encrypted,
      DIFFERENT_ENCRYPTION_KEY_HEX,
    )

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0].message).toContain("Decryption failed")
  })

  it("should fail at the payload level with wrong key", async () => {
    const correctKey = await deriveBackupEncryptionKey(TEST_ENCRYPTION_KEY_HEX)
    const wrongKey = await deriveBackupEncryptionKey(
      DIFFERENT_ENCRYPTION_KEY_HEX,
    )

    const ciphertext = await encryptBackupPayload('{"test": true}', correctKey)

    await expect(decryptBackupPayload(ciphertext, wrongKey)).rejects.toThrow()
  })
})

// ============================================================================
// Header Construction Tests
// ============================================================================

describe("buildBackupHeader", () => {
  it("should include credentialId for passkey accounts", () => {
    const header = buildBackupHeader(createPasskeyAccount())

    expect(header.version).toBe(1)
    expect(header.accountType).toBe("passkey")
    expect(header.accountName).toBe("Test Passkey Account")
    expect(header.credentialId).toBe("credential-abc-123")
    expect(typeof header.exportedAt).toBe("number")
    // No ethereum-specific fields
    expect(header).not.toHaveProperty("ethereumAddress")
    expect(header).not.toHaveProperty("encryptedMasterKey")
    expect(header).not.toHaveProperty("encryptionSalt")
  })

  it("should include ethereum-specific fields for ethereum accounts", () => {
    const header = buildBackupHeader(createEthereumAccount())

    expect(header.accountType).toBe("ethereum")
    expect(header.ethereumAddress).toBe(TEST_ETH_ADDRESS_2_HEX)
    // No passkey-specific fields
    expect(header).not.toHaveProperty("credentialId")
  })

  it("should have no extra fields for agent accounts", () => {
    const header = buildBackupHeader(createAgentAccount())

    expect(header.accountType).toBe("agent")
    expect(header).not.toHaveProperty("credentialId")
    expect(header).not.toHaveProperty("ethereumAddress")
    expect(header).not.toHaveProperty("encryptedMasterKey")
    expect(header).not.toHaveProperty("encryptionSalt")
  })
})

// ============================================================================
// Schema Validation Tests
// ============================================================================

describe("schema validation", () => {
  it("should accept a valid passkey encrypted export", async () => {
    const encrypted = await createEncryptedExport(
      createPasskeyAccount(),
      [],
      [],
      [],
      TEST_ENCRYPTION_KEY_HEX,
    )

    const result = EncryptedSwarmIdExportSchemaV1.safeParse(encrypted)
    expect(result.success).toBe(true)
  })

  it("should accept a valid ethereum encrypted export", async () => {
    const encrypted = await createEncryptedExport(
      createEthereumAccount(),
      [],
      [],
      [],
      TEST_ENCRYPTION_KEY_HEX,
    )

    const result = EncryptedSwarmIdExportSchemaV1.safeParse(encrypted)
    expect(result.success).toBe(true)
  })

  it("should accept a valid agent encrypted export", async () => {
    const encrypted = await createEncryptedExport(
      createAgentAccount(),
      [],
      [],
      [],
      TEST_ENCRYPTION_KEY_HEX,
    )

    const result = EncryptedSwarmIdExportSchemaV1.safeParse(encrypted)
    expect(result.success).toBe(true)
  })

  it("should reject missing ciphertext", () => {
    const result = EncryptedSwarmIdExportSchemaV1.safeParse({
      version: 1,
      accountType: "passkey",
      accountName: "Test",
      credentialId: "cred-123",
      exportedAt: Date.now(),
      // missing ciphertext
    })
    expect(result.success).toBe(false)
  })

  it("should reject invalid accountType", () => {
    const result = EncryptedSwarmIdExportSchemaV1.safeParse({
      version: 1,
      accountType: "invalid",
      accountName: "Test",
      exportedAt: Date.now(),
      ciphertext: "abc",
    })
    expect(result.success).toBe(false)
  })

  it("should reject wrong version number", () => {
    const result = EncryptedSwarmIdExportSchemaV1.safeParse({
      version: 2,
      accountType: "passkey",
      accountName: "Test",
      credentialId: "cred",
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
  it("should parse a valid passkey header", async () => {
    const encrypted = await createEncryptedExport(
      createPasskeyAccount(),
      [],
      [],
      [],
      TEST_ENCRYPTION_KEY_HEX,
    )

    const result = parseEncryptedExportHeader(encrypted)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.header.accountType).toBe("passkey")
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
    const key = await deriveBackupEncryptionKey(TEST_ENCRYPTION_KEY_HEX)
    const plaintext = '{"hello":"world"}'

    const ciphertext = await encryptBackupPayload(plaintext, key)
    expect(typeof ciphertext).toBe("string")
    expect(ciphertext).not.toBe(plaintext)

    const decrypted = await decryptBackupPayload(ciphertext, key)
    expect(decrypted).toBe(plaintext)
  })

  it("should produce different ciphertext for same input (random IV)", async () => {
    const key = await deriveBackupEncryptionKey(TEST_ENCRYPTION_KEY_HEX)
    const plaintext = '{"test":true}'

    const ct1 = await encryptBackupPayload(plaintext, key)
    const ct2 = await encryptBackupPayload(plaintext, key)

    expect(ct1).not.toBe(ct2)
  })
})

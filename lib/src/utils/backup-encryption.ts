/**
 * Backup Encryption Module
 *
 * Provides AES-GCM-256 encryption for .swarmid backup files.
 * The encryption key is derived from the account's swarmEncryptionKey
 * (which is always persisted on all account types), so export requires
 * NO re-authentication. Import requires auth to re-derive the key.
 *
 * Key chain: masterKey → swarmEncryptionKey (stored) → backupKey (HMAC-SHA256)
 */

import { z } from "zod"
import { deriveSecret, hexToUint8Array } from "./key-derivation"
import {
  serializeAccountStateSnapshot,
  deserializeAccountStateSnapshot,
} from "./account-state-snapshot"
import type { AccountStateSnapshotResult } from "./account-state-snapshot"
import type { Account, Identity, ConnectedApp, PostageStamp } from "../schemas"

// ============================================================================
// Constants
// ============================================================================

const BACKUP_KEY_DERIVATION_CONTEXT = "swarm-id-backup-encryption-v1"
const BACKUP_VERSION = 1
const IV_LENGTH_BYTES = 12

// ============================================================================
// Schemas
// ============================================================================

const BackupHeaderBaseSchemaV1 = z.object({
  version: z.literal(BACKUP_VERSION),
  accountName: z.string(),
  exportedAt: z.number(),
  ciphertext: z.string(),
})

export const PasskeyBackupHeaderSchemaV1 = BackupHeaderBaseSchemaV1.extend({
  accountType: z.literal("passkey"),
  credentialId: z.string(),
})

/**
 * Ethereum backup header fields (plaintext, not encrypted):
 *
 * - `ethereumAddress` — validates the user is connecting the correct wallet
 *   before attempting decryption.
 *
 * Key material is NOT stored in the export header. During import the user
 * must enter their secret seed, and the master key is re-derived from
 * `secretSeed + publicKey` via `deriveMasterKey()`.
 */
export const EthereumBackupHeaderSchemaV1 = BackupHeaderBaseSchemaV1.extend({
  accountType: z.literal("ethereum"),
  ethereumAddress: z.string(),
})

export const AgentBackupHeaderSchemaV1 = BackupHeaderBaseSchemaV1.extend({
  accountType: z.literal("agent"),
})

export const EncryptedSwarmIdExportSchemaV1 = z.discriminatedUnion(
  "accountType",
  [
    PasskeyBackupHeaderSchemaV1,
    EthereumBackupHeaderSchemaV1,
    AgentBackupHeaderSchemaV1,
  ],
)

// ============================================================================
// Types
// ============================================================================

export type PasskeyBackupHeader = z.infer<typeof PasskeyBackupHeaderSchemaV1>
export type EthereumBackupHeader = z.infer<typeof EthereumBackupHeaderSchemaV1>
export type AgentBackupHeader = z.infer<typeof AgentBackupHeaderSchemaV1>
export type EncryptedSwarmIdExport = z.infer<
  typeof EncryptedSwarmIdExportSchemaV1
>

export type ParseHeaderResult =
  | { success: true; header: EncryptedSwarmIdExport }
  | { success: false; error: string }

// ============================================================================
// Key Derivation
// ============================================================================

/**
 * Derive an AES-GCM-256 CryptoKey for backup encryption from the stored
 * swarmEncryptionKey. Uses HMAC-SHA256 with a fixed context string.
 */
export async function deriveBackupEncryptionKey(
  swarmEncryptionKeyHex: string,
): Promise<CryptoKey> {
  const backupKeyHex = await deriveSecret(
    swarmEncryptionKeyHex,
    BACKUP_KEY_DERIVATION_CONTEXT,
  )
  const keyBytes = hexToUint8Array(backupKeyHex)

  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ])
}

// ============================================================================
// Encrypt / Decrypt Payload
// ============================================================================

/**
 * Encrypt a plaintext JSON string with AES-GCM-256.
 * Returns base64-encoded [IV (12 bytes) || ciphertext+tag].
 */
export async function encryptBackupPayload(
  plaintextJson: string,
  key: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES))
  const encoded = new TextEncoder().encode(plaintextJson)

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  )

  // Concatenate IV + ciphertext+tag
  const combined = new Uint8Array(iv.length + ciphertextBuffer.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertextBuffer), iv.length)

  return uint8ArrayToBase64(combined)
}

/**
 * Decrypt a base64-encoded [IV (12 bytes) || ciphertext+tag] with AES-GCM-256.
 * Returns the plaintext JSON string.
 */
export async function decryptBackupPayload(
  ciphertextBase64: string,
  key: CryptoKey,
): Promise<string> {
  const combined = base64ToUint8Array(ciphertextBase64)
  const iv = combined.slice(0, IV_LENGTH_BYTES)
  const ciphertext = combined.slice(IV_LENGTH_BYTES)

  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  )

  return new TextDecoder().decode(plaintextBuffer)
}

// ============================================================================
// Header Construction
// ============================================================================

/**
 * Build the plaintext header fields for an encrypted backup,
 * based on the account type.
 *
 * `accountName` and `exportedAt` are deliberately kept in the plaintext
 * header: accountName helps the user identify which credential to use,
 * and exportedAt lets them assess backup recency.
 */
export type BackupHeaderWithoutCiphertext =
  | Omit<PasskeyBackupHeader, "ciphertext">
  | Omit<EthereumBackupHeader, "ciphertext">
  | Omit<AgentBackupHeader, "ciphertext">

export function buildBackupHeader(
  account: Account,
): BackupHeaderWithoutCiphertext {
  const base = {
    version: BACKUP_VERSION as typeof BACKUP_VERSION,
    accountName: account.name,
    exportedAt: Date.now(),
  }

  if (account.type === "passkey") {
    return {
      ...base,
      accountType: "passkey" as const,
      credentialId: account.credentialId,
    }
  }

  if (account.type === "ethereum") {
    return {
      ...base,
      accountType: "ethereum" as const,
      ethereumAddress: account.ethereumAddress.toHex(),
    }
  }

  // agent — no extra fields
  return { ...base, accountType: "agent" as const }
}

// ============================================================================
// High-Level API
// ============================================================================

/**
 * Create a fully encrypted .swarmid export object.
 *
 * 1. Serializes account data to plaintext JSON via serializeAccountStateSnapshot
 * 2. Derives an AES-GCM-256 key from swarmEncryptionKey
 * 3. Encrypts the JSON payload
 * 4. Builds a header with account metadata + ciphertext
 */
export async function createEncryptedExport(
  account: Account,
  identities: Identity[],
  connectedApps: ConnectedApp[],
  postageStamps: PostageStamp[],
  swarmEncryptionKeyHex: string,
): Promise<EncryptedSwarmIdExport> {
  const now = Date.now()
  const exportData = serializeAccountStateSnapshot({
    accountId: account.id.toHex(),
    metadata: {
      accountName: account.name,
      defaultPostageStampBatchID: account.defaultPostageStampBatchID?.toHex(),
      createdAt: account.createdAt,
      lastModified: now,
    },
    identities,
    connectedApps,
    postageStamps,
    timestamp: now,
  })
  const plaintextJson = JSON.stringify(exportData)
  const key = await deriveBackupEncryptionKey(swarmEncryptionKeyHex)
  const ciphertext = await encryptBackupPayload(plaintextJson, key)

  const header = buildBackupHeader(account)
  return EncryptedSwarmIdExportSchemaV1.parse({ ...header, ciphertext })
}

/**
 * Decrypt an encrypted .swarmid export and return the parsed inner data.
 *
 * 1. Validates the encrypted header with Zod
 * 2. Derives the AES-GCM-256 key from swarmEncryptionKey
 * 3. Decrypts the ciphertext
 * 4. Parses the inner plaintext via deserializeAccountStateSnapshot
 */
export async function decryptEncryptedExport(
  encryptedData: unknown,
  swarmEncryptionKeyHex: string,
): Promise<AccountStateSnapshotResult> {
  const headerResult = parseEncryptedExportHeader(encryptedData)
  if (!headerResult.success) {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: "custom",
          message: headerResult.error,
          path: [],
        },
      ]),
    }
  }

  const key = await deriveBackupEncryptionKey(swarmEncryptionKeyHex)

  let plaintextJson: string
  try {
    plaintextJson = await decryptBackupPayload(
      headerResult.header.ciphertext,
      key,
    )
  } catch {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: "custom",
          message: "Decryption failed: wrong key or corrupted data",
          path: ["ciphertext"],
        },
      ]),
    }
  }

  let innerData: unknown
  try {
    innerData = JSON.parse(plaintextJson)
  } catch {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: "custom",
          message: "Decrypted data is not valid JSON",
          path: ["ciphertext"],
        },
      ]),
    }
  }
  return deserializeAccountStateSnapshot(innerData)
}

/**
 * Parse and validate just the encrypted export header (without decrypting).
 * Useful for reading account metadata before attempting decryption.
 */
export function parseEncryptedExportHeader(data: unknown): ParseHeaderResult {
  if (typeof data !== "object" || data === null) {
    return { success: false, error: "Input must be a non-null object" }
  }

  const result = EncryptedSwarmIdExportSchemaV1.safeParse(data)
  if (!result.success) {
    return {
      success: false,
      error: result.error.issues.map((i) => i.message).join("; "),
    }
  }

  return { success: true, header: result.data }
}

// ============================================================================
// Base64 Helpers
// ============================================================================

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

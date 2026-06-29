// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Backup Encryption Module
 *
 * Provides AES-GCM-256 encryption for .swarmid backup files.
 * The encryption key is derived from swarmEncryptionKey, which is itself
 * derived from the account's derivationKey (always persisted on all
 * account types), so export requires NO re-authentication.
 * Import requires auth to re-derive the key.
 *
 * Key chain: masterKey → derivationKey (stored) → swarmEncryptionKey → backupKey (HMAC-SHA256)
 */

import { z } from "zod"
import { deriveSecret, hexToUint8Array } from "./key-derivation"
import {
  serializeAccountStateSnapshot,
  deserializeAccountStateSnapshot,
} from "./account-state-snapshot"
import type { AccountStateSnapshotResult } from "./account-state-snapshot"
import type { Account } from "../schemas"

// ============================================================================
// Constants
// ============================================================================

const BACKUP_KEY_DERIVATION_CONTEXT = "swarm-id-backup-encryption-v1"
const BACKUP_VERSION = 1
const IV_LENGTH_BYTES = 12

// ============================================================================
// Schemas
// ============================================================================

/**
 * Encrypted `.swarmid` export header: plaintext metadata + ciphertext.
 *
 * There is a single account model (a BIP-39 seed account), so the header carries
 * no account-type discriminant and no key material. On import the user re-enters
 * the recovery phrase, from which the master key — and everything derived from
 * it — is recomputed; only the account name + timestamps travel in plaintext.
 */
export const EncryptedSwarmIdExportSchemaV1 = z.object({
  version: z.literal(BACKUP_VERSION),
  accountName: z.string(),
  exportedAt: z.number(),
  ciphertext: z.string(),
})

// ============================================================================
// Types
// ============================================================================

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
 * Build the plaintext header fields for an encrypted backup.
 *
 * `accountName` and `exportedAt` are deliberately kept in the plaintext header:
 * accountName helps the user identify the backup, and exportedAt lets them
 * assess its recency. No key material or device-local seed-vault data
 * (`access` / `encryptedSeed`) is ever exported.
 */
export type BackupHeaderWithoutCiphertext = Omit<
  EncryptedSwarmIdExport,
  "ciphertext"
>

export function buildBackupHeader(
  account: Account,
): BackupHeaderWithoutCiphertext {
  return {
    version: BACKUP_VERSION as typeof BACKUP_VERSION,
    accountName: account.name,
    exportedAt: Date.now(),
  }
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
  swarmEncryptionKeyHex: string,
): Promise<EncryptedSwarmIdExport> {
  const now = Date.now()
  const exportData = serializeAccountStateSnapshot({
    accountId: account.id.toHex(),
    metadata: {
      accountName: account.name,
      defaultPostageStampBatchID: account.defaultPostageStampBatchID?.toHex(),
      publicKey: account.publicKey,
      settings: account.settings,
      createdAt: account.createdAt,
      lastModified: now,
      devices: account.devices,
      partitionCount: account.partitionCount ?? 1,
    },
    connectedApps: account.connectedApps,
    postageStamps: account.postageStamps,
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

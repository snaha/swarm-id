// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * .swarmid backup files. The portable account data (name, stamps, connected
 * apps — never the access method or encrypted seed) is AES-GCM encrypted with
 * a key derived from the recovery-phrase entropy, so the file is useless
 * without the phrase and restoring needs exactly: file + phrase.
 */
import { EthAddress } from '@ethersphere/bee-js'
import {
  type AccountData,
  AccountDataSchemaV1,
  type Account as AccountRecord,
  hexToUint8Array,
  serializeAccountData,
  uint8ArrayToHex,
} from '@snaha/swarm-id'

import { decryptSeed, deriveKeyFromSecret, encryptSeed } from '$lib/crypto/encryption'
import { walletFromPhrase } from '$lib/crypto/mnemonic'

const BACKUP_VERSION = 1
const BACKUP_KEY_INFO = 'swarm-id-backup-v1'
const SALT_LENGTH = 32

interface BackupEnvelope {
  format: 'swarm-id-backup'
  version: number
  salt: string
  payload: string
}

function deriveBackupKey(entropy: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  return deriveKeyFromSecret(entropy, salt, BACKUP_KEY_INFO)
}

function parseEnvelope(fileContents: string): BackupEnvelope | undefined {
  try {
    const envelope = JSON.parse(fileContents) as BackupEnvelope
    if (
      envelope.format === 'swarm-id-backup' &&
      envelope.version === BACKUP_VERSION &&
      typeof envelope.salt === 'string' &&
      typeof envelope.payload === 'string'
    ) {
      return envelope
    }
  } catch {
    // Not JSON — fall through.
  }
  return undefined
}

/**
 * Serialize and encrypt an account into .swarmid file contents. The payload is
 * the lib's portable projection (`serializeAccountData`): plain JSON with
 * byte-class fields as hex, never the seed vault or live per-app session
 * material (`appSecret`/`connectedUntil` — the secret is re-derived from the
 * master key on the next connect).
 */
export async function createBackup(account: AccountRecord, entropy: Uint8Array): Promise<string> {
  const data = serializeAccountData(account)

  const salt = new Uint8Array(SALT_LENGTH)
  crypto.getRandomValues(salt)
  const key = await deriveBackupKey(entropy, salt)

  const envelope: BackupEnvelope = {
    format: 'swarm-id-backup',
    version: BACKUP_VERSION,
    salt: uint8ArrayToHex(salt),
    payload: await encryptSeed(new TextEncoder().encode(JSON.stringify(data)), key),
  }
  return JSON.stringify(envelope)
}

/** Shape check for inline validation — no phrase needed, does not decrypt. */
export function isBackupFile(fileContents: string): boolean {
  return parseEnvelope(fileContents) !== undefined
}

/**
 * Export from the legacy Swarm ID app — same .swarmid extension, but an
 * incompatible envelope and key chain. Detected only to tell the user where
 * the file came from instead of a generic "invalid file" error.
 */
export function isLegacyBackupFile(fileContents: string): boolean {
  try {
    const parsed = JSON.parse(fileContents) as { accountType?: unknown; ciphertext?: unknown }
    return typeof parsed.accountType === 'string' && typeof parsed.ciphertext === 'string'
  } catch {
    return false
  }
}

/**
 * Decrypt .swarmid file contents with the recovery phrase. Throws when the
 * file is not a backup, the phrase does not match the file, or the backed-up
 * account does not belong to the phrase.
 */
export async function restoreBackup(fileContents: string, phrase: string): Promise<AccountData> {
  const envelope = parseEnvelope(fileContents)
  if (!envelope) {
    throw new Error('Not a valid backup file.')
  }

  let salt: Uint8Array
  try {
    salt = hexToUint8Array(envelope.salt)
    hexToUint8Array(envelope.payload) // corrupt hex is a file problem, not a phrase mismatch
  } catch {
    throw new Error('Not a valid backup file.')
  }

  const wallet = walletFromPhrase(phrase)
  const key = await deriveBackupKey(wallet.entropy, salt)

  let plaintext: Uint8Array
  try {
    plaintext = await decryptSeed(envelope.payload, key)
  } catch {
    throw new Error('The recovery phrase does not match this backup.')
  }

  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    throw new Error('Not a valid backup file.')
  }
  // Rehydrate byte-class fields through the shared portable schema — the exact
  // shape `createBackup` wrote (no device-local seed vault to fake or strip).
  const result = AccountDataSchemaV1.safeParse(raw)
  if (!result.success) {
    throw new Error('Not a valid backup file.')
  }
  const parsed = result.data
  if (!parsed.id.equals(new EthAddress(wallet.address))) {
    throw new Error('The recovery phrase does not match this backup.')
  }
  return parsed
}

/** Backup filename like 20260610.swarmid */
export function backupFilename(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}${month}${day}.swarmid`
}

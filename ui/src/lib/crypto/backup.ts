// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * .swarmid backup files. The portable account data (name, stamps, connected
 * apps — never the access method or encrypted seed) is AES-GCM encrypted with
 * a key derived from the recovery-phrase entropy, so the file is useless
 * without the phrase and restoring needs exactly: file + phrase.
 */
import {
  type Account as AccountRecord,
  AccountSchemaV1,
  serializeConnectedApp,
  serializePostageStamp,
} from '@snaha/swarm-id'

import { decryptSeed, deriveKeyFromSecret, encryptSeed } from '$lib/crypto/encryption'
import { bytesToHex, hexToBytes } from '$lib/crypto/hex'
import { walletFromPhrase } from '$lib/crypto/mnemonic'
import type { AccountData } from '$lib/types'
import { bareHex } from '$lib/utils'

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
 * Serialize and encrypt an account into .swarmid file contents. Byte-class
 * fields (id, batch ids, stamps) are projected to hex through the lib
 * serializers so the payload is plain JSON — never the access method or
 * encrypted seed.
 */
export async function createBackup(account: AccountRecord, entropy: Uint8Array): Promise<string> {
  const data = {
    id: account.id.toHex(),
    name: account.name,
    publicKey: account.publicKey,
    createdAt: account.createdAt,
    derivationKey: account.derivationKey,
    settings: account.settings,
    defaultPostageStampBatchID: account.defaultPostageStampBatchID?.toHex(),
    devices: account.devices,
    // Strip `appSecret` from every connected app: it is the live session secret
    // the dApp's proxy authenticates from, re-derivable from the master key on
    // the next connect. Backing it up would let a restore silently re-authenticate
    // apps without an explicit reconnect (and needlessly ships a secret).
    connectedApps: account.connectedApps.map((app) => {
      const { appSecret: _appSecret, ...withoutSecret } = serializeConnectedApp(app)
      return withoutSecret
    }),
    postageStamps: account.postageStamps.map(serializePostageStamp),
    partitionCount: account.partitionCount,
  }

  const salt = new Uint8Array(SALT_LENGTH)
  crypto.getRandomValues(salt)
  const key = await deriveBackupKey(entropy, salt)

  const envelope: BackupEnvelope = {
    format: 'swarm-id-backup',
    version: BACKUP_VERSION,
    salt: bytesToHex(salt),
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
    salt = hexToBytes(envelope.salt)
    hexToBytes(envelope.payload) // corrupt hex is a file problem, not a phrase mismatch
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
  // Rehydrate byte-class fields through the shared Zod schema. Access/seed are
  // device-local and never in the file, so pass placeholders and drop them. The
  // seed placeholder must still be non-empty even-length hex to satisfy the
  // schema's `encryptedSeed` regex — its value is irrelevant since it's stripped
  // below.
  const result = AccountSchemaV1.safeParse({
    ...(raw as Record<string, unknown>),
    access: { type: 'password', kdfSalt: '', kdfIterations: 0 },
    encryptedSeed: '00',
  })
  if (!result.success) {
    throw new Error('Not a valid backup file.')
  }
  const parsed = result.data
  if (parsed.id.toHex() !== bareHex(wallet.address)) {
    throw new Error('The recovery phrase does not match this backup.')
  }
  const { access: _access, encryptedSeed: _encryptedSeed, ...portable } = parsed
  return portable
}

/** Backup filename like 20260610.swarmid */
export function backupFilename(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}${month}${day}.swarmid`
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * .swarmid backup files. The portable account data (name, stamps, connected
 * apps — never the access method or encrypted seed) is AES-GCM encrypted with
 * a key derived from the recovery-phrase entropy, so the file is useless
 * without the phrase and restoring needs exactly: file + phrase.
 */
import { bytesToHex, hexToBytes } from '$lib/crypto/hex'
import { walletFromPhrase } from '$lib/crypto/mnemonic'
import type { Account, AccountData } from '$lib/types'

const BACKUP_VERSION = 1
const AES_GCM = 'AES-GCM'
const AES_KEY_BITS = 256
const IV_LENGTH = 12
const SALT_LENGTH = 32

interface BackupEnvelope {
  format: 'swarm-id-backup'
  version: number
  salt: string
  payload: string
}

async function deriveBackupKey(entropy: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', entropy as BufferSource, 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: new TextEncoder().encode('swarm-id-backup-v1'),
    },
    ikm,
    { name: AES_GCM, length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Serialize and encrypt an account into .swarmid file contents. */
export async function createBackup(account: Account, entropy: Uint8Array): Promise<string> {
  const data: AccountData = {
    id: account.id,
    name: account.name,
    publicKey: account.publicKey,
    createdAt: account.createdAt,
    appConnectionDays: account.appConnectionDays,
    defaultStampBatchId: account.defaultStampBatchId,
    stamps: account.stamps,
    connectedApps: account.connectedApps,
  }

  const salt = new Uint8Array(SALT_LENGTH)
  crypto.getRandomValues(salt)
  const iv = new Uint8Array(IV_LENGTH)
  crypto.getRandomValues(iv)

  const key = await deriveBackupKey(entropy, salt)
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_GCM, iv: iv as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify(data)),
  )
  const payload = new Uint8Array(IV_LENGTH + ciphertext.byteLength)
  payload.set(iv)
  payload.set(new Uint8Array(ciphertext), IV_LENGTH)

  const envelope: BackupEnvelope = {
    format: 'swarm-id-backup',
    version: BACKUP_VERSION,
    salt: bytesToHex(salt),
    payload: bytesToHex(payload),
  }
  return JSON.stringify(envelope)
}

/**
 * Decrypt .swarmid file contents with the recovery phrase. Throws when the
 * file is not a backup, the phrase does not match the file, or the backed-up
 * account does not belong to the phrase.
 */
export async function restoreBackup(fileContents: string, phrase: string): Promise<AccountData> {
  let envelope: BackupEnvelope
  try {
    envelope = JSON.parse(fileContents) as BackupEnvelope
  } catch {
    throw new Error('Not a valid backup file.')
  }
  if (envelope.format !== 'swarm-id-backup' || envelope.version !== BACKUP_VERSION) {
    throw new Error('Not a valid backup file.')
  }

  const wallet = walletFromPhrase(phrase)
  const key = await deriveBackupKey(wallet.entropy, hexToBytes(envelope.salt))
  const payload = hexToBytes(envelope.payload)

  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: AES_GCM, iv: payload.slice(0, IV_LENGTH) as BufferSource },
      key,
      payload.slice(IV_LENGTH) as BufferSource,
    )
  } catch {
    throw new Error('The recovery phrase does not match this backup.')
  }

  const data = JSON.parse(new TextDecoder().decode(plaintext)) as AccountData
  if (data.id.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error('The recovery phrase does not match this backup.')
  }
  return data
}

/** Backup filename like 20260610.swarmid */
export function backupFilename(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}${month}${day}.swarmid`
}

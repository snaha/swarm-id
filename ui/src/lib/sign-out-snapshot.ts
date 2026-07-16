// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The encrypted snapshot a sign-out keeps of the synced account state, so
 * sign-back-in restores it losslessly without the network. Same shape as the
 * .swarmid backup (`$lib/crypto/backup`): the portable projection
 * (`serializeSyncedAccount` — never the seed vault or live per-app session
 * secrets) AES-GCM encrypted. The key derives from the account's
 * `derivationKey` — in memory at sign-out (no unlock happens there) and
 * re-derived from the seed at sign-back-in — instead of the phrase entropy.
 */
import {
  type SyncedAccount,
  SyncedAccountSchemaV1,
  hexToUint8Array,
  isSignedOutAccount,
  serializeSyncedAccount,
  uint8ArrayToHex,
} from '@snaha/swarm-id'

import { decryptSeed, deriveKeyFromSecret, encryptSeed, randomSalt } from '$lib/crypto/encryption'
import type { Account } from '$lib/types'

const SNAPSHOT_VERSION = 1
const SNAPSHOT_KEY_INFO = 'swarm-id-signout-state-v1'

interface SnapshotEnvelope {
  format: 'swarm-id-signout-state'
  version: number
  salt: string
  payload: string
}

function deriveSnapshotKey(derivationKey: string, salt: Uint8Array): Promise<CryptoKey> {
  return deriveKeyFromSecret(hexToUint8Array(derivationKey), salt, SNAPSHOT_KEY_INFO)
}

/** Serialize and encrypt the account's synced state for the sign-out remnant. */
export async function encryptSignOutSnapshot(account: Account): Promise<string> {
  const record = account.toRecord()
  if (isSignedOutAccount(record)) {
    throw new Error('Cannot snapshot a signed-out account: its state is already stripped.')
  }
  const data = serializeSyncedAccount(record)

  const salt = randomSalt()
  const key = await deriveSnapshotKey(account.derivationKey, salt)

  const envelope: SnapshotEnvelope = {
    format: 'swarm-id-signout-state',
    version: SNAPSHOT_VERSION,
    salt: uint8ArrayToHex(salt),
    payload: await encryptSeed(new TextEncoder().encode(JSON.stringify(data)), key),
  }
  return JSON.stringify(envelope)
}

/**
 * Decrypt a sign-out snapshot back into the synced state. Throws on a corrupt
 * envelope or a key mismatch — the caller falls back to folding from Swarm.
 */
export async function decryptSignOutSnapshot(
  encryptedState: string,
  derivationKey: string,
): Promise<SyncedAccount> {
  const envelope = JSON.parse(encryptedState) as SnapshotEnvelope
  if (
    envelope.format !== 'swarm-id-signout-state' ||
    envelope.version !== SNAPSHOT_VERSION ||
    typeof envelope.salt !== 'string' ||
    typeof envelope.payload !== 'string'
  ) {
    throw new Error('Not a sign-out state snapshot.')
  }

  const key = await deriveSnapshotKey(derivationKey, hexToUint8Array(envelope.salt))
  const plaintext = await decryptSeed(envelope.payload, key)
  const raw: unknown = JSON.parse(new TextDecoder().decode(plaintext))
  return SyncedAccountSchemaV1.parse(raw)
}

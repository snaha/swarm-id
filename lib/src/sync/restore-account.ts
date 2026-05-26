// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Restore Account from Swarm
 *
 * When a passkey auth succeeds but no local account exists (e.g. new device),
 * this utility derives the keys needed to find and decrypt the account
 * snapshot stored in Swarm and returns the restored state.
 */

import {
  Bee,
  PrivateKey,
  EthAddress,
  Topic,
  Reference,
  type Bytes,
} from "@ethersphere/bee-js"
import {
  deriveAccountDerivationKey,
  deriveSwarmEncryptionKey,
  deriveSecret,
} from "../utils/key-derivation"
import { ACCOUNT_SYNC_TOPIC_PREFIX } from "./sync-account"
import { AsyncEpochFinder } from "../proxy/feeds/epochs/async-finder"
import { downloadDataWithChunkAPI } from "../proxy/download-data"
import { deserializeAccountState } from "./serialization"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"

/**
 * Result of a successful account restore from Swarm
 */
export interface RestoreAccountResult {
  snapshot: AccountStateSnapshot
  derivationKey: string
  credentialId: string
}

/**
 * Thrown when the epoch feed contains a snapshot reference but the chunks
 * backing that reference cannot be downloaded — i.e. the backup exists in
 * the feed but the data is not reachable from this Bee endpoint.
 *
 * Distinct from a generic network error so the UI can show a more useful
 * message ("backup found but not retrievable" vs. "could not reach Swarm").
 */
export class SnapshotDataUnavailableError extends Error {
  readonly reference: string
  readonly cause: unknown

  constructor(reference: string, cause: unknown) {
    const message =
      cause instanceof Error ? cause.message : String(cause ?? "unknown")
    super(`Snapshot data unavailable for ref ${reference}: ${message}`)
    this.name = "SnapshotDataUnavailableError"
    this.reference = reference
    this.cause = cause
  }
}

/**
 * Restore account state from Swarm using passkey authentication result
 *
 * @param bee - Bee client instance
 * @param masterKey - Master key from passkey authentication
 * @param ethereumAddress - Account ID (EthAddress) from passkey authentication
 * @param credentialId - Credential ID from passkey authentication
 * @returns Restored account state, or undefined if no backup found in Swarm
 */
export async function restoreAccountFromSwarm(
  bee: Bee,
  masterKey: Bytes,
  ethereumAddress: EthAddress,
  credentialId: string,
): Promise<RestoreAccountResult | undefined> {
  const accountId = ethereumAddress.toHex()

  console.log(`[RestoreAccount] bee.url=${bee.url} accountId=${accountId}`)

  // 1. Derive the derivation key and swarm encryption key from the master key
  const derivationKey = await deriveAccountDerivationKey(masterKey.toHex())
  const swarmEncryptionKey = await deriveSwarmEncryptionKey(derivationKey)

  // 2. Derive the backup key (used as feed owner)
  const backupKeyHex = await deriveSecret(swarmEncryptionKey, "backup-key")
  const backupKey = new PrivateKey(backupKeyHex)
  const owner = backupKey.publicKey().address()

  // 3. Build the feed topic
  const topic = Topic.fromString(`${ACCOUNT_SYNC_TOPIC_PREFIX}:${accountId}`)

  // 4. Look up the latest epoch feed entry
  // Note: feed SOCs are uploaded unencrypted (sync-account.ts doesn't pass
  // encryptionKey to updater.update()), so the finder must NOT use one either.
  const finder = new AsyncEpochFinder(bee, topic, owner)
  const now = BigInt(Math.floor(Date.now() / 1000))

  const refBytes = await finder.findAt(now)

  if (!refBytes) {
    return undefined
  }

  // 5. Download and decrypt the account snapshot
  const reference = new Reference(refBytes)
  let data: Uint8Array
  try {
    data = await downloadDataWithChunkAPI(bee, reference.toHex())
  } catch (error) {
    throw new SnapshotDataUnavailableError(reference.toHex(), error)
  }

  // 6. Deserialize the snapshot
  const snapshot = deserializeAccountState(data)

  return {
    snapshot,
    derivationKey,
    credentialId,
  }
}

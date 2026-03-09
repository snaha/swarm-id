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
  deriveAccountSwarmEncryptionKey,
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
  swarmEncryptionKey: string
  credentialId: string
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

  // 1. Derive the swarm encryption key from the master key
  const swarmEncryptionKey = await deriveAccountSwarmEncryptionKey(
    masterKey.toHex(),
  )

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
  const data = await downloadDataWithChunkAPI(bee, reference.toHex())

  // 6. Deserialize the snapshot
  const snapshot = deserializeAccountState(data)

  return {
    snapshot,
    swarmEncryptionKey,
    credentialId,
  }
}

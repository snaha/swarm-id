// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pull the latest account snapshot from Swarm and fold it into local stores.
 *
 * Unlike `restoreAccountFromSwarm`, this doesn't need the master key — it
 * uses the local account's `derivationKey` (already stored after sign-in)
 * to derive the snapshot feed's owner and encryption key. So it's safe to
 * call from any signed-in page, including after the temporary master key
 * has been cleared.
 */
import { Bee, EthAddress, PrivateKey, Reference, Topic } from '@ethersphere/bee-js'
import {
  ACCOUNT_SYNC_TOPIC_PREFIX,
  AsyncEpochFinder,
  SnapshotDataUnavailableError,
  deriveSecret,
  deriveSwarmEncryptionKey,
  deserializeAccountState,
  detectDeviceName,
  downloadDataWithChunkAPI,
  getOrCreateDeviceId,
  mergeConnectedApps,
  mergeDevices,
  mergeDevicesList,
  mergePostageStamps,
} from '@snaha/swarm-id'

import { sharedAccountsStore } from '$lib/dev/accounts.svelte'
import { networkSettingsStore } from '$lib/dev/network-settings.svelte'

export type RefreshResult =
  | { ok: true; refreshedAt: number }
  // The backup feed has no reachable entry on this node — typically the
  // previous backup was stamped by a now-expired batch and garbage-
  // collected, and a republish with the new batch hasn't landed yet.
  // Benign and self-healing; the UI guides the user to wait / publish.
  | { ok: false; kind: 'no-backup' }
  // Invalid id, missing local account, unretrievable chunks, or network
  // failure — a genuine error the user should see.
  | { ok: false; kind: 'error'; error: string }

export async function refreshAccountFromSwarm(accountId: string): Promise<RefreshResult> {
  let ethAddress: EthAddress
  try {
    ethAddress = new EthAddress(accountId)
  } catch {
    return { ok: false, kind: 'error', error: 'Invalid account id' }
  }

  const account = sharedAccountsStore.getAccount(ethAddress)
  if (!account) {
    return { ok: false, kind: 'error', error: 'No local account for this id' }
  }

  const bee = new Bee(networkSettingsStore.beeNodeUrl)

  try {
    // Derive the snapshot feed's owner / encryption key. Same derivation
    // chain as `restoreAccountFromSwarm` but starting from the locally
    // stored derivationKey instead of the master key.
    const swarmEncryptionKey = await deriveSwarmEncryptionKey(account.derivationKey)
    const backupKeyHex = await deriveSecret(swarmEncryptionKey, 'backup-key')
    const backupKey = new PrivateKey(backupKeyHex)
    const owner = backupKey.publicKey().address()
    const topic = Topic.fromString(`${ACCOUNT_SYNC_TOPIC_PREFIX}:${account.id.toHex()}`)

    // Note: feed SOCs are uploaded unencrypted (sync-account.ts doesn't
    // pass encryptionKey to updater.update()), so the finder must not
    // use one either.
    const finder = new AsyncEpochFinder(bee, topic, owner)
    const now = BigInt(Math.floor(Date.now() / 1000))
    const refBytes = await finder.findAt(now)

    if (!refBytes) {
      return { ok: false, kind: 'no-backup' }
    }

    let data: Uint8Array
    try {
      data = await downloadDataWithChunkAPI(bee, new Reference(refBytes).toHex())
    } catch (err) {
      throw new SnapshotDataUnavailableError(new Reference(refBytes).toHex(), err)
    }

    const snapshot = deserializeAccountState(data)

    console.debug(
      `[RefreshAccount] devices=${snapshot.metadata.devices.length} apps=${snapshot.connectedApps.length} stamps=${snapshot.postageStamps.length} bee=${bee.url}`,
    )

    // Merge the remote snapshot into this account's nested local state and apply
    // it WITHOUT re-publishing (refresh data shouldn't be re-uploaded). Reuses
    // the exact publish-side merge primitives from the lib so the rules can't
    // drift (#337): apps LWW by appUrl (tombstone-aware), stamps union by
    // batchID (local wins), devices prefer the larger `lastSignedInAt`.
    const mergedApps = mergeConnectedApps(account.connectedApps, snapshot.connectedApps)
    const mergedStamps = mergePostageStamps(account.postageStamps, snapshot.postageStamps)

    // Keep *this* device first-class even if the snapshot was written by a peer
    // that doesn't know about us yet.
    const mergedDevices = mergeDevices(
      mergeDevicesList(account.devices, snapshot.metadata.devices),
      getOrCreateDeviceId(),
      detectDeviceName(),
    )

    sharedAccountsStore.applyRefreshed(ethAddress, {
      devices: mergedDevices,
      connectedApps: mergedApps,
      postageStamps: mergedStamps,
    })

    return { ok: true, refreshedAt: Date.now() }
  } catch (err) {
    const error =
      err instanceof SnapshotDataUnavailableError
        ? `Backup feed entry exists but its chunks aren't retrievable from ${bee.url} (ref ${err.reference.slice(0, 8)}…)`
        : err instanceof Error
          ? err.message
          : 'Unknown error'
    return { ok: false, kind: 'error', error }
  }
}

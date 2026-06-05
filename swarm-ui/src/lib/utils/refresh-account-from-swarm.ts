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

import { Bee, PrivateKey, Reference, Topic, EthAddress } from '@ethersphere/bee-js'
import {
  ACCOUNT_SYNC_TOPIC_PREFIX,
  AsyncEpochFinder,
  collectAccountStampBatchIds,
  deriveSecret,
  deriveSwarmEncryptionKey,
  deserializeAccountState,
  detectDeviceName,
  downloadDataWithChunkAPI,
  getOrCreateDeviceId,
  mergeDevices,
  SnapshotDataUnavailableError,
  type ConnectedApp,
  type Device,
  type PostageStamp,
} from '@snaha/swarm-id'
import { accountsStore } from '$lib/stores/accounts.svelte'
import { identitiesStore } from '$lib/stores/identities.svelte'
import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

// Union two lists by a natural key, local winning on collision — mirrors the
// array merge in `lib/src/sync/merge-snapshot.ts`.
function unionByKey<T>(local: T[], remote: T[], key: (item: T) => string): T[] {
  const merged = new Map<string, T>()
  for (const item of remote) merged.set(key(item), item)
  for (const item of local) merged.set(key(item), item) // local wins
  return Array.from(merged.values())
}

// Merge connected apps last-writer-wins per app so updates AND removals
// propagate (a revoke is a tombstone carrying a fresh `updatedAt`). Mirrors
// `mergeConnectedApps` in merge-snapshot.ts. `updatedAt` falls back to
// `lastConnectedAt` for pre-existing records.
function mergeConnectedAppsLww(local: ConnectedApp[], remote: ConnectedApp[]): ConnectedApp[] {
  const keyOf = (a: ConnectedApp) => `${a.identityId}:${a.appUrl}`
  const recency = (a: ConnectedApp) => a.updatedAt ?? a.lastConnectedAt ?? 0
  const merged = new Map<string, ConnectedApp>()
  for (const a of [...remote, ...local]) {
    const existing = merged.get(keyOf(a))
    if (!existing || recency(a) >= recency(existing)) merged.set(keyOf(a), a)
  }
  return Array.from(merged.values())
}

// Union device lists by deviceId, preferring the larger `lastSignedInAt`
// (local wins on a tie) — mirrors `mergeDevicesList` in merge-snapshot.ts.
function mergeDeviceLists(local: Device[], remote: Device[]): Device[] {
  const merged = new Map<string, Device>()
  for (const d of remote) merged.set(d.deviceId, d)
  for (const d of local) {
    const existing = merged.get(d.deviceId)
    if (!existing || (d.lastSignedInAt ?? 0) >= (existing.lastSignedInAt ?? 0)) {
      merged.set(d.deviceId, d)
    }
  }
  return Array.from(merged.values())
}

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

  const account = accountsStore.getAccount(ethAddress)
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
      `[RefreshAccount] devices=${snapshot.metadata.devices.length} identities=${snapshot.identities.length} apps=${snapshot.connectedApps.length} stamps=${snapshot.postageStamps.length} bee=${bee.url}`,
    )

    // Merge the remote snapshot into this account's local state and apply every
    // part to the stores WITHOUT re-publishing. Previously only `devices` was
    // applied, so connectedApps/identities/stamps added on another device never
    // reached an already-known device. Union semantics mirror the publish merge
    // (`lib/src/sync/merge-snapshot.ts`): union by natural key, local wins on
    // collision; devices prefer the larger `lastSignedInAt`.
    const localIdentities = identitiesStore.getIdentitiesByAccount(account.id)
    const localApps = localIdentities.flatMap((i) => connectedAppsStore.getAppsByIdentityId(i.id))
    const localStamps = collectAccountStampBatchIds(account, localIdentities)
      .map((batchId) => postageStampsStore.getStamp(batchId))
      .filter((s): s is PostageStamp => s !== undefined)

    const mergedIdentities = unionByKey(localIdentities, snapshot.identities, (i) => i.id)
    const mergedApps = mergeConnectedAppsLww(localApps, snapshot.connectedApps)
    const mergedStamps = unionByKey(localStamps, snapshot.postageStamps, (s) => s.batchID.toHex())

    // Keep *this* device first-class even if the snapshot was written by a peer
    // that doesn't know about us yet.
    const mergedDevices = mergeDevices(
      mergeDeviceLists(account.devices, snapshot.metadata.devices),
      getOrCreateDeviceId(),
      detectDeviceName(),
    )

    accountsStore.applyRefreshedSnapshot(ethAddress, { devices: mergedDevices })
    identitiesStore.applyRefreshed(account.id, mergedIdentities)
    connectedAppsStore.applyRefreshed(
      mergedIdentities.map((i) => i.id),
      mergedApps,
    )
    postageStampsStore.applyRefreshed(mergedStamps)

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

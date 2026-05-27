// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  claimPartitionEagerly,
  deriveSwarmEncryptionKey,
  getOrCreateDeviceId,
  hexToUint8Array,
  type Account,
} from '@snaha/swarm-id'
import { Bee } from '@ethersphere/bee-js'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
import { accountsStore } from '$lib/stores/accounts.svelte'

/**
 * Best-effort eager partition claim during sign-in.
 *
 * Hides the claim latency under the sign-in UX (passkey prompt, navigation,
 * etc.) so the user's first upload doesn't pay the full TTL on a third
 * device joining. On success, updates `activeDevices` in the local account
 * store; the storage listener picks that change up and fires `triggerSync`,
 * republishing the snapshot to Swarm.
 *
 * Fire-and-forget. Aborts when the user navigates away (caller wires the
 * `AbortController` to `beforeunload`).
 */
export async function claimPartitionDuringSignin(
  account: Account,
  signal?: AbortSignal,
): Promise<void> {
  // Nothing to claim if this account isn't on a multi-device batch.
  if (!account.partitionCount || account.partitionCount <= 1) return
  if (!account.defaultPostageStampBatchID) return
  if (signal?.aborted) return

  try {
    const swarmEncryptionKey = await deriveSwarmEncryptionKey(account.derivationKey)
    const encryptionKey = hexToUint8Array(swarmEncryptionKey)

    const stamp = postageStampsStore.getStamp(account.defaultPostageStampBatchID)
    if (!stamp) return

    const stamper = await postageStampsStore.getStamper(account.defaultPostageStampBatchID, {
      owner: stamp.signerKey.publicKey().address(),
      encryptionKey,
    })
    if (!stamper) return

    const bee = new Bee(networkSettingsStore.beeNodeUrl)

    const result = await claimPartitionEagerly({
      bee,
      stamper,
      derivationKey: account.derivationKey,
      batchId: account.defaultPostageStampBatchID,
      batchDepth: stamp.depth,
      activeDevices: account.activeDevices ?? [],
      partitionCount: account.partitionCount,
      deviceId: getOrCreateDeviceId(),
      abortSignal: signal,
    })

    if (result.partition === undefined) return
    if (signal?.aborted) return

    // Mirror the new activeDevices into local state. The storage listener
    // diffs activeDevices and fires `triggerSync` → snapshot republishes.
    accountsStore.applyRefreshedSnapshot(account.id, {
      devices: account.devices,
      activeDevices: result.activeDevices,
    })
  } catch (err) {
    // Best-effort — the proxy's upload-time acquire path is the safety net.
    console.warn('[signin] claimPartitionDuringSignin failed:', err)
  }
}

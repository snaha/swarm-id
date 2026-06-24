// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pull account state from Swarm and fold it into local stores.
 *
 * Phase 3a: reads the device-registry feed for discovery and folds every
 * device's own state feed (`foldAccountFromSwarm`) instead of a single shared
 * snapshot. Uses the local account's `derivationKey` (stored after sign-in) to
 * derive the feed owner / encryption key, so it's safe from any signed-in page.
 *
 * Scalars (name / default stamp / settings) are NOT applied here — local wins,
 * as before. Cross-device scalar propagation is a follow-up tied to per-field
 * clocks (the wire format already carries them).
 */

import { Bee, EthAddress } from '@ethersphere/bee-js'
import {
  foldAccountFromSwarm,
  mergeConnectedApps,
  mergeDevices,
  mergeDevicesList,
  mergePostageStamps,
  getOrCreateDeviceId,
  detectDeviceName,
} from '@snaha/swarm-id'
import { accountsStore } from '$lib/stores/accounts.svelte'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

export type RefreshResult =
  | { ok: true; refreshedAt: number }
  // No device-registry on this node yet — nothing has been published, or the
  // previous backup expired and the republish hasn't landed. Benign.
  | { ok: false; kind: 'no-backup' }
  // Invalid id, missing local account, or network failure.
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
    const folded = await foldAccountFromSwarm({
      bee,
      derivationKey: account.derivationKey,
      accountId: account.id.toHex(),
    })

    if (!folded) {
      return { ok: false, kind: 'no-backup' }
    }

    const remote = folded.account
    console.debug(
      `[RefreshAccount] devices=${remote.devices.length} apps=${remote.connectedApps.length} stamps=${remote.postageStamps.length} bee=${bee.url}`,
    )

    // Merge the folded remote state into local (reusing the lib primitives so the
    // rules can't drift — #337). Keep this device first-class even if no peer
    // feed lists it yet.
    const mergedApps = mergeConnectedApps(account.connectedApps, remote.connectedApps)
    const mergedStamps = mergePostageStamps(account.postageStamps, remote.postageStamps)
    const mergedDevices = mergeDevices(
      mergeDevicesList(account.devices, remote.devices),
      getOrCreateDeviceId(),
      detectDeviceName(),
    )

    accountsStore.applyRefreshed(ethAddress, {
      devices: mergedDevices,
      connectedApps: mergedApps,
      postageStamps: mergedStamps,
    })

    return { ok: true, refreshedAt: Date.now() }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error'
    return { ok: false, kind: 'error', error }
  }
}

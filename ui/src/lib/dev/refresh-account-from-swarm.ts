// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pull the latest account state from Swarm and fold it into local stores.
 *
 * Unlike `restoreAccountFromSwarm`, this doesn't need the master key — it uses
 * the local account's `derivationKey` (already stored after sign-in) to derive
 * the feed owner and encryption key. So it's safe to call from any signed-in
 * page, including after the temporary master key has been cleared.
 *
 * It delegates the read to the lib's `foldAccountFromSwarm`, which scans the
 * append-only device roster and folds every device's per-device state feed
 * (Phase 3a). Doing the read in the lib keeps the discovery + merge rules in
 * one place — the old hand-rolled reader pointed at the retired shared snapshot
 * feed and would simply find nothing now that publishing is per-device.
 */
import { Bee, EthAddress } from '@ethersphere/bee-js'
import {
  detectDeviceName,
  foldAccountFromSwarm,
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
  // No device has published a state feed yet (empty roster) — the read
  // equivalent of "no backup". Benign and self-healing; the UI guides the user
  // to publish / wait.
  | { ok: false; kind: 'no-backup' }
  // Invalid id, missing local account, or a network failure — a genuine error
  // the user should see.
  | { ok: false; kind: 'error'; error: string }

export async function refreshAccountFromSwarm(accountId: string): Promise<RefreshResult> {
  let ethAddress: EthAddress
  try {
    ethAddress = new EthAddress(accountId)
  } catch {
    return { ok: false, kind: 'error', error: 'Invalid account id' }
  }

  const account = sharedAccountsStore.get(ethAddress)
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

    const { account: state, devices } = folded
    console.debug(
      `[RefreshAccount] devices=${devices.length} apps=${state.connectedApps.length} stamps=${state.postageStamps.length} bee=${bee.url}`,
    )

    // `foldAccountFromSwarm` folds across the *remote* device feeds only — it
    // knows nothing about local state that hasn't been published yet (e.g. a
    // fresh drive tombstone awaiting its debounced sync). Merge the folded
    // collections with the local ones using the same LWW/tombstone primitives
    // the publish side uses, so a local change can't be clobbered by an older
    // remote value (and a local tombstone survives a stale remote active copy).
    const mergedApps = mergeConnectedApps(account.connectedApps, state.connectedApps)
    const mergedStamps = mergePostageStamps(account.postageStamps, state.postageStamps)
    // Keep *this* device first-class even if no feed lists it yet.
    const mergedDevices = mergeDevices(
      mergeDevicesList(account.devices, state.devices),
      getOrCreateDeviceId(),
      detectDeviceName(),
    )

    // Apply WITHOUT re-publishing (the data came from Swarm). Scalars carry
    // their per-field clocks so `applyRefreshed` folds them by LWW against the
    // local value.
    account.applyRefreshed({
      devices: mergedDevices,
      connectedApps: mergedApps,
      postageStamps: mergedStamps,
      accountName: state.accountName,
      accountNameAt: state.accountNameAt,
      defaultPostageStampBatchID: state.defaultPostageStampBatchID,
      defaultStampAt: state.defaultStampAt,
      settings: state.settings,
      settingsAt: state.settingsAt,
    })

    return { ok: true, refreshedAt: Date.now() }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error'
    return { ok: false, kind: 'error', error }
  }
}

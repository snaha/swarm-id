// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Account } from '@snaha/swarm-id'
import { mergeDevices, getOrCreateDeviceId, detectDeviceName } from '@snaha/swarm-id'
import { accountsStore } from '$lib/stores/accounts.svelte'

/**
 * Add a restored (nested) account to the store. The account already carries its
 * connected apps and postage stamps inline; we only register this device and
 * reset app sessions (a restored backup's sessions have logically expired — apps
 * show as "previously connected" but require a reconnect to re-arm the timer).
 */
export function restoreAccountToStores(account: Account): Account {
  const devices = mergeDevices(account.devices ?? [], getOrCreateDeviceId(), detectDeviceName())
  const connectedApps = account.connectedApps.map((app) => ({
    ...app,
    connectedUntil: undefined,
  }))
  return accountsStore.addAccount({ ...account, devices, connectedApps })
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { browser } from '$app/environment'
import { EthAddress, BatchId } from '@ethersphere/bee-js'
import {
  createAccountsStorageManager,
  getOrCreateDeviceId,
  STORAGE_KEY_ACCOUNTS,
  type Account,
  type ActiveDevice,
  type Device,
} from '@snaha/swarm-id'
import { triggerSync } from '$lib/utils/sync-hooks'

// ============================================================================
// Storage Manager
// ============================================================================

const storageManager = createAccountsStorageManager()

function loadAccounts(): Account[] {
  if (!browser) return []
  return storageManager.load()
}

function saveAccounts(data: Account[]): void {
  storageManager.save(data)
}

// ============================================================================
// Reactive Store
// ============================================================================

let accounts = $state<Account[]>(loadAccounts())

function sameActiveDevices(a: ActiveDevice[] | undefined, b: ActiveDevice[] | undefined): boolean {
  const ka = (a ?? [])
    .map((e) => `${e.deviceId}:${e.partition}`)
    .sort()
    .join(',')
  const kb = (b ?? [])
    .map((e) => `${e.deviceId}:${e.partition}`)
    .sort()
    .join(',')
  return ka === kb
}

if (browser) {
  const selfDeviceId = getOrCreateDeviceId()
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY_ACCOUNTS) return
    const previous = accounts
    const next = loadAccounts()
    accounts = next
    // If the proxy iframe just updated an account's activeDevices (e.g.
    // after a successful partition-lease bootstrap), publish the new
    // snapshot to Swarm. The merge-before-write step in sync-account
    // prevents this from stomping any peer's recent write.
    //
    // Only trigger sync when THIS device is in the updated activeDevices —
    // otherwise the publish in sync-account refuses (a device without a
    // partition lease shouldn't write to Swarm) and we'd just log a noisy
    // "Refusing to sync" warning for every demote / yield-on-close /
    // cross-tab snapshot refresh.
    for (const updated of next) {
      const before = previous.find((a) => a.id.equals(updated.id))
      if (!before) continue // new account — sign-in handles its own bootstrap
      if (!sameActiveDevices(before.activeDevices, updated.activeDevices)) {
        const selfNowActive = (updated.activeDevices ?? []).some((d) => d.deviceId === selfDeviceId)
        if (selfNowActive) {
          triggerSync(updated.id.toHex())
        }
      }
    }
  })
}

export const accountsStore = {
  get accounts() {
    return accounts
  },

  addAccount(account: Account): Account {
    accounts = [...accounts, account]
    saveAccounts(accounts)
    // Do not call triggerSync here — sign-in doesn't grant a partition
    // lease yet, and an inactive device must not write to Swarm. The
    // first upload (via the proxy) claims a partition, then the storage
    // listener above picks that up and fires the sync.
    return account
  },

  removeAccount(id: EthAddress) {
    accounts = accounts.filter((a) => !a.id.equals(id))
    saveAccounts(accounts)
  },

  getAccount(id: EthAddress): Account | undefined {
    return accounts.find((a) => a.id.equals(id))
  },

  setAccountName(id: EthAddress, name: string) {
    accounts = accounts.map((account) => (account.id.equals(id) ? { ...account, name } : account))
    saveAccounts(accounts)
    triggerSync(id.toHex())
  },

  updateDevices(id: EthAddress, devices: Device[]) {
    accounts = accounts.map((account) =>
      account.id.equals(id) ? { ...account, devices } : account,
    )
    saveAccounts(accounts)
  },

  /**
   * Apply a snapshot just fetched from Swarm. Updates `devices` and
   * `activeDevices` in-place without firing `triggerSync` — the data
   * came from Swarm, re-publishing it would be wasted bandwidth and
   * could clobber a more recent peer write.
   */
  applyRefreshedSnapshot(
    id: EthAddress,
    fields: { devices: Device[]; activeDevices: ActiveDevice[] },
  ): void {
    accounts = accounts.map((account) =>
      account.id.equals(id)
        ? {
            ...account,
            devices: fields.devices,
            activeDevices: fields.activeDevices,
          }
        : account,
    )
    saveAccounts(accounts)
  },

  setDefaultStamp(id: EthAddress, batchID: BatchId | undefined) {
    accounts = accounts.map((account) =>
      account.id.equals(id)
        ? {
            ...account,
            defaultPostageStampBatchID: batchID,
          }
        : account,
    )
    saveAccounts(accounts)
    triggerSync(id.toHex())
  },

  clear() {
    accounts = []
    storageManager.clear()
  },
}

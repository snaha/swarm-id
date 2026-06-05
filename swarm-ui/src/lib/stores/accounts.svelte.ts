// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { browser } from '$app/environment'
import { EthAddress, BatchId } from '@ethersphere/bee-js'
import {
  createAccountsStorageManager,
  STORAGE_KEY_ACCOUNTS,
  type Account,
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

if (browser) {
  // Cross-tab refresh: when another tab on the same origin mutates the
  // accounts list (sign-in, sign-out, identity add, stamp purchase), pick
  // up the new value so this tab's reactive state stays in sync. Lease
  // state is no longer mirrored in the account record — the lock SOC is the
  // source of truth — so there's nothing lease-related to diff here.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY_ACCOUNTS) return
    accounts = loadAccounts()
  })
}

export const accountsStore = {
  get accounts() {
    return accounts
  },

  addAccount(account: Account): Account {
    accounts = [...accounts, account]
    saveAccounts(accounts)
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
   * Apply a snapshot just fetched from Swarm. Updates `devices` in-place
   * without firing `triggerSync` — the data came from Swarm, re-publishing
   * it would be wasted bandwidth and could clobber a more recent peer write.
   */
  applyRefreshedSnapshot(id: EthAddress, fields: { devices: Device[] }): void {
    accounts = accounts.map((account) =>
      account.id.equals(id)
        ? {
            ...account,
            devices: fields.devices,
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

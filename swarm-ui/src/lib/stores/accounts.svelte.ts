// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { browser } from '$app/environment'
import { EthAddress, BatchId } from '@ethersphere/bee-js'
import {
  createAccountsStorageManager,
  STORAGE_KEY_ACCOUNTS,
  type Account,
  type ConnectedApp,
  type Device,
  type PostageStamp,
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
  // Cross-tab refresh: when another tab on the same origin mutates the nested
  // account document (sign-in, sign-out, app connect, stamp purchase), pick up
  // the new value so this tab's reactive state stays in sync.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY_ACCOUNTS) return
    accounts = loadAccounts()
  })
}

/**
 * Map the account `id` through `fn`, persist, and (unless `skipSync`) trigger a
 * Swarm publish for it. The single mutation primitive for the nested account.
 */
function update(
  id: EthAddress,
  fn: (account: Account) => Account,
  { skipSync = false }: { skipSync?: boolean } = {},
): void {
  let changed = false
  accounts = accounts.map((account) => {
    if (!account.id.equals(id)) return account
    changed = true
    return fn(account)
  })
  if (!changed) return
  saveAccounts(accounts)
  if (!skipSync) triggerSync(id.toHex())
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
    update(id, (account) => ({ ...account, name }))
  },

  updateDevices(id: EthAddress, devices: Device[]) {
    update(id, (account) => ({ ...account, devices }), { skipSync: true })
  },

  // Tombstone a device (set `removedAt`) so the removal propagates to other
  // devices (#337). A later sign-in on that device re-activates it (the merge
  // clock is max(removedAt, lastSignedInAt)). This is the method a future
  // "sign-out removes this device" path would call for the current device.
  removeDevice(
    id: EthAddress,
    deviceId: string,
    { skipSync = false }: { skipSync?: boolean } = {},
  ) {
    const now = Date.now()
    update(
      id,
      (account) => ({
        ...account,
        devices: account.devices.map((d) =>
          d.deviceId === deviceId ? { ...d, removedAt: now } : d,
        ),
      }),
      { skipSync },
    )
  },

  setDefaultStamp(id: EthAddress, batchID: BatchId | undefined) {
    update(id, (account) => ({ ...account, defaultPostageStampBatchID: batchID }))
  },

  setSessionDuration(id: EthAddress, appSessionDuration: number | undefined) {
    update(id, (account) => ({
      ...account,
      settings: { ...account.settings, appSessionDuration },
    }))
  },

  // --------------------------------------------------------------------------
  // Connected apps (account-owned, keyed by appUrl)
  // --------------------------------------------------------------------------

  /** All apps for an account, INCLUDING revoked tombstones (for the synced snapshot). */
  getApps(id: EthAddress): ConnectedApp[] {
    return this.getAccount(id)?.connectedApps ?? []
  },

  /** Displayable (non-revoked) apps for an account. */
  getActiveApps(id: EthAddress): ConnectedApp[] {
    return this.getApps(id).filter((app) => !app.revokedAt)
  },

  /** A still-valid connection for `appUrl` under `id`, or undefined. */
  getValidConnection(id: EthAddress, appUrl: string): ConnectedApp | undefined {
    const app = this.getApps(id).find((a) => a.appUrl === appUrl)
    if (!app || app.revokedAt) return undefined
    if (!app.connectedUntil || !app.appSecret) return undefined
    if (app.connectedUntil <= Date.now()) return undefined
    return app
  },

  /**
   * Every (account, app) connection across all accounts, most-recently-connected
   * first. Used by the connect popup to order prior connections.
   */
  getRecentConnections(): { account: Account; app: ConnectedApp }[] {
    return accounts
      .flatMap((account) =>
        account.connectedApps.filter((app) => !app.revokedAt).map((app) => ({ account, app })),
      )
      .sort((a, b) => b.app.lastConnectedAt - a.app.lastConnectedAt)
  },

  addOrUpdateApp(
    id: EthAddress,
    appData: Omit<ConnectedApp, 'lastConnectedAt'> & {
      appIcon?: string
      appDescription?: string
      appSecret?: string
    },
    defaultConnectionTime: number | undefined,
  ): ConnectedApp {
    const now = Date.now()
    let result: ConnectedApp | undefined
    update(id, (account) => {
      const existing = account.connectedApps.find((a) => a.appUrl === appData.appUrl)
      const connectedUntil =
        defaultConnectionTime !== undefined ? now + defaultConnectionTime : undefined
      const app: ConnectedApp = existing
        ? {
            ...existing,
            appName: appData.appName,
            appIcon: appData.appIcon ?? existing.appIcon,
            appDescription: appData.appDescription ?? existing.appDescription,
            appSecret: appData.appSecret ?? existing.appSecret,
            postageStampBatchID: appData.postageStampBatchID ?? existing.postageStampBatchID,
            lastConnectedAt: now,
            connectedUntil,
            updatedAt: now,
            // Reconnecting clears any prior revocation tombstone.
            revokedAt: undefined,
          }
        : {
            appUrl: appData.appUrl,
            appName: appData.appName,
            appIcon: appData.appIcon,
            appDescription: appData.appDescription,
            appSecret: appData.appSecret,
            postageStampBatchID: appData.postageStampBatchID,
            lastConnectedAt: now,
            connectedUntil,
            updatedAt: now,
          }
      result = app
      const connectedApps = existing
        ? account.connectedApps.map((a) => (a.appUrl === app.appUrl ? app : a))
        : [...account.connectedApps, app]
      return { ...account, connectedApps }
    })
    return result!
  },

  /** Soft disconnect: invalidate the session but keep the entry (no tombstone). */
  disconnectApp(id: EthAddress, appUrl: string) {
    const now = Date.now()
    update(id, (account) => ({
      ...account,
      connectedApps: account.connectedApps.map((app) =>
        app.appUrl === appUrl
          ? { ...app, lastConnectedAt: 0, connectedUntil: undefined, updatedAt: now }
          : app,
      ),
    }))
  },

  /**
   * Revoke an app: keep a `revokedAt` tombstone so the removal propagates via the
   * LWW merge, but clear the session so it no longer authenticates and is hidden.
   */
  revokeApp(id: EthAddress, appUrl: string) {
    const now = Date.now()
    update(id, (account) => ({
      ...account,
      connectedApps: account.connectedApps.map((app) =>
        app.appUrl === appUrl
          ? {
              ...app,
              appSecret: undefined,
              connectedUntil: undefined,
              lastConnectedAt: 0,
              revokedAt: now,
              updatedAt: now,
            }
          : app,
      ),
    }))
  },

  // --------------------------------------------------------------------------
  // Postage stamps (account-owned set; the default is `defaultPostageStampBatchID`)
  // --------------------------------------------------------------------------

  /** Displayable (non-deleted) stamps for an account. */
  getStamps(id: EthAddress): PostageStamp[] {
    return (this.getAccount(id)?.postageStamps ?? []).filter((s) => !s.deletedAt)
  },

  addStamp(id: EthAddress, stamp: Omit<PostageStamp, 'createdAt'>): PostageStamp {
    const newStamp: PostageStamp = { ...stamp, createdAt: Date.now() }
    update(id, (account) => {
      if (account.postageStamps.some((s) => s.batchID.equals(stamp.batchID))) {
        throw new Error(`Postage stamp with batch ID ${stamp.batchID.toHex()} already exists`)
      }
      return { ...account, postageStamps: [...account.postageStamps, newStamp] }
    })
    return newStamp
  },

  // Tombstone the stamp (set `deletedAt`) instead of dropping it, so the removal
  // propagates to other devices (#337). `skipSync` controls immediate publish
  // only; a skipped tombstone still propagates on the next sync.
  removeStamp(id: EthAddress, batchID: BatchId, { skipSync = false }: { skipSync?: boolean } = {}) {
    const now = Date.now()
    update(
      id,
      (account) => ({
        ...account,
        postageStamps: account.postageStamps.map((s) =>
          s.batchID.equals(batchID) ? { ...s, deletedAt: now } : s,
        ),
        // Never leave a default pointing at a stamp we just removed.
        defaultPostageStampBatchID: account.defaultPostageStampBatchID?.equals(batchID)
          ? undefined
          : account.defaultPostageStampBatchID,
      }),
      { skipSync },
    )
  },

  /** Update a stamp's volatile utilization in place, WITHOUT firing sync. */
  updateStampUtilization(id: EthAddress, batchID: BatchId, utilization: number) {
    update(
      id,
      (account) => ({
        ...account,
        postageStamps: account.postageStamps.map((s) =>
          s.batchID.equals(batchID) ? { ...s, utilization } : s,
        ),
      }),
      { skipSync: true },
    )
  },

  // --------------------------------------------------------------------------
  // Refresh-from-Swarm application (no re-publish)
  // --------------------------------------------------------------------------

  /**
   * Apply state just merged from a Swarm refresh to one account, WITHOUT firing
   * `triggerSync` (the data came from Swarm; re-publishing would be wasted
   * bandwidth and could clobber a fresher peer write).
   */
  applyRefreshed(
    id: EthAddress,
    fields: {
      devices?: Device[]
      connectedApps?: ConnectedApp[]
      postageStamps?: PostageStamp[]
    },
  ): void {
    update(
      id,
      (account) => ({
        ...account,
        devices: fields.devices ?? account.devices,
        connectedApps: fields.connectedApps ?? account.connectedApps,
        postageStamps: fields.postageStamps ?? account.postageStamps,
      }),
      { skipSync: true },
    )
  },

  clear() {
    accounts = []
    storageManager.clear()
  },
}

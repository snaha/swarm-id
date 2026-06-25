// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, EthAddress } from '@ethersphere/bee-js'
import {
  type AccessMethod,
  type Account,
  type ConnectedApp,
  type Device,
  type PostageStamp,
  STORAGE_KEY_ACCOUNTS,
  createAccountsStorageManager,
} from '@snaha/swarm-id'

import { browser } from '$app/environment'

// ============================================================================
// Accounts store — the single source of truth
//
// Wraps the `@snaha/swarm-id` Zod-validated storage manager (persisted under
// `STORAGE_KEY_ACCOUNTS`): the SAME nested-account document the proxy iframe and
// sync engine read. The product UI, the /dev tooling, and the sync subsystem all
// drive off this one reactive store — there is no separate display model.
//
// The UI only ever creates `local` accounts. Mutations that touch `access` /
// `encryptedSeed` therefore guard on `type === 'local'`.
// ============================================================================

const MS_PER_DAY = 24 * 60 * 60 * 1000

const storageManager = createAccountsStorageManager()

function loadAccounts(): Account[] {
  if (!browser) return []
  return storageManager.load()
}

let accounts = $state<Account[]>(loadAccounts())

if (browser) {
  // Cross-tab refresh: another tab mutating the account document (sign-in,
  // app connect, stamp purchase) updates this tab's reactive state too.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY_ACCOUNTS) return
    accounts = loadAccounts()
  })
}

/**
 * Optional sync hook. The /dev sync subsystem injects `triggerSync` so its
 * mutations publish to Swarm; the plain product app leaves it unset, so a
 * rename or app-connect never attempts a network publish.
 */
let syncHook: ((accountIdHex: string) => void) | undefined

export function setAccountsSyncHook(hook: (accountIdHex: string) => void): void {
  syncHook = hook
}

function toEthAddress(id: string | EthAddress): EthAddress {
  return typeof id === 'string' ? new EthAddress(id) : id
}

function persist(): void {
  storageManager.save(accounts)
}

function getById(id: string | EthAddress): Account | undefined {
  const ethId = toEthAddress(id)
  return accounts.find((account) => account.id.equals(ethId))
}

/**
 * Map the matching account through `fn`, persist, and (unless `skipSync`) fire
 * the sync hook for it. The single mutation primitive.
 */
function update(
  id: string | EthAddress,
  fn: (account: Account) => Account,
  { skipSync = false }: { skipSync?: boolean } = {},
): void {
  const ethId = toEthAddress(id)
  let changed = false
  accounts = accounts.map((account) => {
    if (!account.id.equals(ethId)) return account
    changed = true
    return fn(account)
  })
  if (!changed) return
  persist()
  if (!skipSync) syncHook?.(ethId.toHex())
}

/** Revoke an app connection: drop the secret so the dApp proxy de-authenticates. */
function revoked(app: ConnectedApp, tombstone: boolean): ConnectedApp {
  const now = Date.now()
  return {
    ...app,
    appSecret: undefined,
    connectedUntil: undefined,
    lastConnectedAt: 0,
    updatedAt: now,
    revokedAt: tombstone ? now : app.revokedAt,
  }
}

export const accountsStore = {
  get accounts(): Account[] {
    return accounts
  },

  /** Re-read from shared storage (e.g. after a direct storage manager write). */
  reload(): void {
    accounts = loadAccounts()
  },

  get(id: string | EthAddress): Account | undefined {
    return getById(id)
  },

  /** Alias used by the sync engine / dev tooling (keyed by EthAddress). */
  getAccount(id: EthAddress): Account | undefined {
    return getById(id)
  },

  add(account: Account): Account {
    // Replace any previous record for the same address (sign-in / restore).
    accounts = [...accounts.filter((existing) => !existing.id.equals(account.id)), account]
    persist()
    return account
  },

  addAccount(account: Account): Account {
    return accountsStore.add(account)
  },

  remove(id: string | EthAddress): void {
    const ethId = toEthAddress(id)
    accounts = accounts.filter((account) => !account.id.equals(ethId))
    persist()
  },

  removeAccount(id: EthAddress): void {
    accountsStore.remove(id)
  },

  /** Drop every account from this browser (used by the /dev "Clear all data" tool). */
  clear(): void {
    accounts = []
    storageManager.clear()
  },

  rename(id: string | EthAddress, name: string): void {
    update(id, (account) => ({ ...account, name }))
  },

  setAccountName(id: EthAddress, name: string): void {
    accountsStore.rename(id, name)
  },

  /** Swap the unlock method: new access metadata + seed re-encrypted for it. */
  setAccess(id: string | EthAddress, access: AccessMethod, encryptedSeed: string): void {
    update(id, (account) =>
      account.type === 'local' ? { ...account, access, encryptedSeed } : account,
    )
  },

  /** How long app connections stay valid, set in days (stored as ms). */
  setAppConnectionDays(id: string | EthAddress, days: number): void {
    update(id, (account) => ({
      ...account,
      settings: { ...account.settings, appSessionDuration: days * MS_PER_DAY },
    }))
  },

  setSessionDuration(id: EthAddress, appSessionDuration: number | undefined): void {
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
    return getById(id)?.connectedApps ?? []
  },

  /** Displayable (non-revoked) apps for an account. */
  getActiveApps(id: EthAddress): ConnectedApp[] {
    return accountsStore.getApps(id).filter((app) => !app.revokedAt)
  },

  /** Record a (re)connection — replaces any previous entry for the app. */
  connectApp(id: string | EthAddress, app: ConnectedApp): void {
    update(id, (account) => {
      const has = account.connectedApps.some((existing) => existing.appUrl === app.appUrl)
      const connectedApps = has
        ? account.connectedApps.map((existing) =>
            existing.appUrl === app.appUrl
              ? { ...existing, ...app, revokedAt: undefined }
              : existing,
          )
        : [...account.connectedApps, app]
      return { ...account, connectedApps }
    })
  },

  disconnectApp(id: string | EthAddress, appUrl: string): void {
    update(id, (account) => ({
      ...account,
      connectedApps: account.connectedApps.map((app) =>
        app.appUrl === appUrl ? revoked(app, false) : app,
      ),
    }))
  },

  /** Disconnect and tombstone so the removal propagates to sync. */
  removeApp(id: string | EthAddress, appUrl: string): void {
    update(id, (account) => ({
      ...account,
      connectedApps: account.connectedApps.map((app) =>
        app.appUrl === appUrl ? revoked(app, true) : app,
      ),
    }))
  },

  // --------------------------------------------------------------------------
  // Drives — an account's owned Swarm storage, each backed by a postage stamp
  // batch on the Bee node (persisted as the lib `postageStamps` field; the
  // default is `defaultPostageStampBatchID`).
  // --------------------------------------------------------------------------

  getDrives(id: EthAddress): PostageStamp[] {
    return getById(id)?.postageStamps ?? []
  },

  addDrive(id: EthAddress, drive: Omit<PostageStamp, 'createdAt'>): PostageStamp {
    const newDrive: PostageStamp = { ...drive, createdAt: Date.now() }
    update(id, (account) => {
      if (account.postageStamps.some((existing) => existing.batchID.equals(drive.batchID))) {
        throw new Error(`Drive with batch ID ${drive.batchID.toHex()} already exists`)
      }
      return { ...account, postageStamps: [...account.postageStamps, newDrive] }
    })
    return newDrive
  },

  removeDrive(
    id: EthAddress,
    batchID: BatchId,
    { skipSync = false }: { skipSync?: boolean } = {},
  ): void {
    update(
      id,
      (account) => ({
        ...account,
        postageStamps: account.postageStamps.filter((drive) => !drive.batchID.equals(batchID)),
        // Never leave a default pointing at a drive we just removed.
        defaultPostageStampBatchID: account.defaultPostageStampBatchID?.equals(batchID)
          ? undefined
          : account.defaultPostageStampBatchID,
      }),
      { skipSync },
    )
  },

  /** Update a drive's volatile utilization in place, WITHOUT firing sync. */
  updateDriveUtilization(id: EthAddress, batchID: BatchId, utilization: number): void {
    update(
      id,
      (account) => ({
        ...account,
        postageStamps: account.postageStamps.map((drive) =>
          drive.batchID.equals(batchID) ? { ...drive, utilization } : drive,
        ),
      }),
      { skipSync: true },
    )
  },

  setDefaultDrive(id: string | EthAddress, batchID: BatchId | undefined): void {
    update(id, (account) => ({ ...account, defaultPostageStampBatchID: batchID }))
  },

  updateDevices(id: EthAddress, devices: Device[]): void {
    update(id, (account) => ({ ...account, devices }), { skipSync: true })
  },

  /**
   * Apply state merged from a Swarm refresh to one account, WITHOUT re-publishing
   * (the data came from Swarm).
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
}

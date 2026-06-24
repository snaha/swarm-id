// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { Account, ConnectedApp, PostageStamp } from '$lib/types'

const STORAGE_KEY = 'swarm-id-accounts-v2'

function load(): Account[] {
  if (typeof localStorage === 'undefined') {
    return []
  }
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    return JSON.parse(raw) as Account[]
  } catch {
    return []
  }
}

function createAccountsStore() {
  let accounts = $state<Account[]>(load())

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts))
  }

  // Keep tabs in sync: another tab writing accounts updates this one.
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) {
        accounts = load()
      }
    })
  }

  function update(id: string, change: (account: Account) => Account) {
    accounts = accounts.map((account) => (account.id === id ? change(account) : account))
    persist()
  }

  return {
    get accounts() {
      return accounts
    },
    get(id: string): Account | undefined {
      return accounts.find((account) => account.id === id)
    },
    add(account: Account) {
      // Replace any previous record for the same address (sign-in / restore).
      accounts = [...accounts.filter((existing) => existing.id !== account.id), account]
      persist()
    },
    rename(id: string, name: string) {
      update(id, (account) => ({ ...account, name }))
    },
    remove(id: string) {
      accounts = accounts.filter((account) => account.id !== id)
      persist()
    },
    /** Swap the unlock method: new access metadata + seed re-encrypted for it. */
    setAccess(id: string, access: Account['access'], encryptedSeed: string) {
      update(id, (account) => ({ ...account, access, encryptedSeed }))
    },
    setAppConnectionDays(id: string, days: number) {
      update(id, (account) => ({ ...account, appConnectionDays: days }))
    },
    /** Record a (re)connection — replaces any previous entry for the app. */
    connectApp(id: string, app: ConnectedApp) {
      update(id, (account) => ({
        ...account,
        connectedApps: [
          ...account.connectedApps.filter((existing) => existing.appUrl !== app.appUrl),
          app,
        ],
      }))
    },
    disconnectApp(id: string, appUrl: string) {
      update(id, (account) => ({
        ...account,
        connectedApps: account.connectedApps.map((app) =>
          app.appUrl === appUrl ? { ...app, connectedUntil: undefined } : app,
        ),
      }))
    },
    removeApp(id: string, appUrl: string) {
      update(id, (account) => ({
        ...account,
        connectedApps: account.connectedApps.filter((app) => app.appUrl !== appUrl),
      }))
    },
    /**
     * Add or replace a postage stamp on the account (deduped by batch id). The
     * first stamp added becomes the account default so uploads have something
     * to spend against without a separate assignment step.
     */
    addStamp(id: string, stamp: PostageStamp) {
      update(id, (account) => ({
        ...account,
        stamps: [...account.stamps.filter((existing) => existing.batchId !== stamp.batchId), stamp],
        defaultStampBatchId: account.defaultStampBatchId ?? stamp.batchId,
      }))
    },
    removeStamp(id: string, batchId: string) {
      update(id, (account) => {
        const stamps = account.stamps.filter((stamp) => stamp.batchId !== batchId)
        // Drop the default when it points at the removed stamp; fall back to
        // whatever remains so the account never references a missing batch.
        const defaultStampBatchId =
          account.defaultStampBatchId === batchId ? stamps[0]?.batchId : account.defaultStampBatchId
        return { ...account, stamps, defaultStampBatchId }
      })
    },
    setDefaultStamp(id: string, batchId: string | undefined) {
      update(id, (account) => ({ ...account, defaultStampBatchId: batchId }))
    },
    /** Wipe every account from this device (developer reset). */
    clear() {
      accounts = []
      persist()
    },
  }
}

export const accountsStore = createAccountsStore()

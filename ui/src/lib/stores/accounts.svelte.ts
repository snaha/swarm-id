// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, EthAddress } from '@ethersphere/bee-js'
import {
  type AccessMethod,
  type Account as AccountRecord,
  type ConnectedApp,
  type Device,
  type PostageStamp,
  STORAGE_KEY_ACCOUNTS,
  createAccountsStorageManager,
} from '@snaha/swarm-id'

import { browser } from '$app/environment'

const MS_PER_DAY = 24 * 60 * 60 * 1000

type AccountSettings = { appSessionDuration?: number }

/**
 * The account aggregate root. Fields are reactive (`$state`) so component reads
 * update on mutation, and every mutator is a method **on the object** that
 * persists the whole collection through the injected `onChange` — callers mutate
 * the account they already hold (`account.rename(…)`), never a store method that
 * takes an id and looks the account up.
 *
 * The shape is the shared `@snaha/swarm-id` `Account` record (byte-class fields,
 * serialized to hex by the lib storage manager). The private `#onChange` makes
 * the class nominal, so a plain record can't be mistaken for a live account.
 *
 * Scalar fields each carry a per-field last-writer-wins clock
 * (`accountNameAt` / `defaultStampAt` / `settingsAt`) so concurrent edits to
 * different scalars on different devices converge instead of clobbering. A
 * mutator that changes a scalar MUST stamp the matching clock; the sync engine
 * (a follow-up PR) folds them by LWW.
 */
export class Account {
  readonly id: EthAddress
  readonly createdAt: number
  readonly derivationKey: string
  // Initialized here so the runes compiler tracks them; real values are set
  // from the record in the constructor.
  name = $state('')
  publicKey = $state('')
  access = $state<AccessMethod>({ type: 'password', kdfSalt: '', kdfIterations: 0 })
  encryptedSeed = $state('')
  settings = $state<AccountSettings | undefined>(undefined)
  defaultPostageStampBatchID = $state<BatchId | undefined>(undefined)
  devices = $state<Device[]>([])
  connectedApps = $state<ConnectedApp[]>([])
  postageStamps = $state<PostageStamp[]>([])
  accountNameAt = $state<number | undefined>(undefined)
  defaultStampAt = $state<number | undefined>(undefined)
  settingsAt = $state<number | undefined>(undefined)
  lastModified = $state<number | undefined>(undefined)
  partitionCount = $state<number | undefined>(undefined)
  readonly #onChange: () => void

  constructor(record: AccountRecord, onChange: () => void) {
    this.id = record.id
    this.createdAt = record.createdAt
    this.derivationKey = record.derivationKey
    this.name = record.name
    this.publicKey = record.publicKey
    this.access = record.access
    this.encryptedSeed = record.encryptedSeed
    this.settings = record.settings
    this.defaultPostageStampBatchID = record.defaultPostageStampBatchID
    this.devices = record.devices
    this.connectedApps = record.connectedApps
    this.postageStamps = record.postageStamps
    this.accountNameAt = record.accountNameAt
    this.defaultStampAt = record.defaultStampAt
    this.settingsAt = record.settingsAt
    this.lastModified = record.lastModified
    this.partitionCount = record.partitionCount
    this.#onChange = onChange
  }

  #persist() {
    this.#onChange()
  }

  /** Active (non-revoked) connected apps — what the UI displays. */
  get activeApps(): ConnectedApp[] {
    return this.connectedApps.filter((app) => !app.revokedAt)
  }

  /** Live (non-tombstoned) stamps — what the UI displays. */
  get stamps(): PostageStamp[] {
    return this.postageStamps.filter((stamp) => stamp.deletedAt === undefined)
  }

  rename(name: string) {
    const now = Date.now()
    this.name = name
    this.accountNameAt = now
    this.lastModified = now
    this.#persist()
  }

  /** Swap the unlock method: new access metadata + seed re-encrypted for it. */
  setAccess(access: AccessMethod, encryptedSeed: string) {
    this.access = access
    this.encryptedSeed = encryptedSeed
    this.lastModified = Date.now()
    this.#persist()
  }

  /** How long app connections stay valid, set in days (stored as ms). */
  setAppConnectionDays(days: number) {
    const now = Date.now()
    this.settings = { ...this.settings, appSessionDuration: days * MS_PER_DAY }
    this.settingsAt = now
    this.lastModified = now
    this.#persist()
  }

  // --------------------------------------------------------------------------
  // Connected apps (keyed by appUrl)
  // --------------------------------------------------------------------------

  /** Record a (re)connection — replaces any previous entry for the same app. */
  connectApp(app: ConnectedApp) {
    const has = this.connectedApps.some((existing) => existing.appUrl === app.appUrl)
    this.connectedApps = has
      ? this.connectedApps.map((existing) =>
          existing.appUrl === app.appUrl ? { ...existing, ...app, revokedAt: undefined } : existing,
        )
      : [...this.connectedApps, app]
    this.lastModified = Date.now()
    this.#persist()
  }

  disconnectApp(appUrl: string) {
    this.connectedApps = this.connectedApps.map((app) =>
      app.appUrl === appUrl ? revoked(app, false) : app,
    )
    this.lastModified = Date.now()
    this.#persist()
  }

  /** Disconnect and tombstone so the removal propagates to sync. */
  removeApp(appUrl: string) {
    this.connectedApps = this.connectedApps.map((app) =>
      app.appUrl === appUrl ? revoked(app, true) : app,
    )
    this.lastModified = Date.now()
    this.#persist()
  }
}

/** Revoke an app connection: drop the secret so the dApp proxy de-authenticates. */
function revoked(app: ConnectedApp, tombstone: boolean): ConnectedApp {
  const now = Date.now()
  return {
    ...app,
    // Clear only the auth material; keep `lastConnectedAt` so the connect flow
    // can still order this account by when it was last used (a revoked app must
    // not read as "never used").
    appSecret: undefined,
    connectedUntil: undefined,
    updatedAt: now,
    revokedAt: tombstone ? now : app.revokedAt,
  }
}

// ============================================================================
// Collection store — create / look up / remove whole accounts. Per-account
// state changes live on the Account object itself.
//
// Backed by the `@snaha/swarm-id` Zod storage manager (key STORAGE_KEY_ACCOUNTS)
// — the SAME nested-account document the proxy iframe reads. The product UI
// drives off this one reactive store.
// ============================================================================

const storageManager = createAccountsStorageManager()

let accounts = $state<Account[]>([])

function persist(): void {
  // Class instances are structurally `Account` records; the lib serializer
  // reads their fields and converts byte classes to hex.
  storageManager.save(accounts)
}

function hydrate(record: AccountRecord): Account {
  return new Account(record, persist)
}

function load(): Account[] {
  if (!browser) return []
  return storageManager.load().map(hydrate)
}

accounts = load()

if (browser) {
  // Cross-tab refresh: another tab mutating the account document (sign-in,
  // app connect, stamp purchase) updates this tab's reactive state too.
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY_ACCOUNTS) accounts = load()
  })
}

function toEthAddress(id: string | EthAddress): EthAddress {
  // `EthAddress` parses a bare or `0x`-prefixed hex string, so a raw stored id
  // and a caller's `.toHex()` both work.
  return typeof id === 'string' ? new EthAddress(id) : id
}

export const accountsStore = {
  get accounts(): Account[] {
    return accounts
  },

  get(id: string | EthAddress): Account | undefined {
    const ethId = toEthAddress(id)
    return accounts.find((account) => account.id.equals(ethId))
  },

  /** Create — or replace, for sign-in / restore — an account; returns the live object. */
  add(record: AccountRecord): Account {
    const account = hydrate(record)
    accounts = [...accounts.filter((existing) => !existing.id.equals(account.id)), account]
    persist()
    return account
  },

  remove(id: string | EthAddress): void {
    const ethId = toEthAddress(id)
    accounts = accounts.filter((account) => !account.id.equals(ethId))
    persist()
  },
}

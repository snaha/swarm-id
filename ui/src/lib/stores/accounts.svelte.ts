// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, EthAddress } from '@ethersphere/bee-js'
import {
  type AccessMethod,
  type ConnectedApp,
  type Device,
  type LocalAccount,
  type PostageStamp,
  STORAGE_KEY_ACCOUNTS,
  createAccountsStorageManager,
} from '@snaha/swarm-id'

import { browser } from '$app/environment'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * The account aggregate root. Fields are reactive (`$state`) so component reads
 * update on mutation, and every mutator is a method **on the object** that
 * persists the whole collection through the injected `onChange` — callers mutate
 * the account they already hold (`account.addDrive(…)`), never a store method
 * that takes an id and looks the account up.
 *
 * The shape is the shared `@snaha/swarm-id` `LocalAccount` (byte-class fields,
 * serialized to hex by the lib storage manager). A drive is an account's owned
 * Swarm storage, persisted as the lib `postageStamps` field. The private
 * `#onChange` makes the class nominal, so plain `LocalAccount` data can't be
 * mistaken for a live account.
 */
export class Account {
  readonly type = 'local' as const
  readonly id: EthAddress
  readonly createdAt: number
  readonly derivationKey: string
  // Initialized here so the runes compiler tracks them; real values are set
  // from the record in the constructor.
  name = $state('')
  publicKey = $state<string | undefined>(undefined)
  access = $state<AccessMethod>({ type: 'password', kdfSalt: '', kdfIterations: 0 })
  encryptedSeed = $state('')
  settings = $state<{ appSessionDuration?: number } | undefined>(undefined)
  defaultPostageStampBatchID = $state<BatchId | undefined>(undefined)
  devices = $state<Device[]>([])
  connectedApps = $state<ConnectedApp[]>([])
  postageStamps = $state<PostageStamp[]>([])
  lastModified = $state<number | undefined>(undefined)
  partitionCount = $state<number | undefined>(undefined)
  readonly #onChange: (account: Account, options?: { skipSync?: boolean }) => void

  constructor(
    record: LocalAccount,
    onChange: (account: Account, options?: { skipSync?: boolean }) => void,
  ) {
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
    this.lastModified = record.lastModified
    this.partitionCount = record.partitionCount
    this.#onChange = onChange
  }

  #persist(options?: { skipSync?: boolean }) {
    this.#onChange(this, options)
  }

  /** Active (non-revoked) connected apps — what the UI displays. */
  get activeApps(): ConnectedApp[] {
    return this.connectedApps.filter((app) => !app.revokedAt)
  }

  rename(name: string) {
    this.name = name
    this.#persist()
  }

  /** Swap the unlock method: new access metadata + seed re-encrypted for it. */
  setAccess(access: AccessMethod, encryptedSeed: string) {
    this.access = access
    this.encryptedSeed = encryptedSeed
    this.#persist()
  }

  /** How long app connections stay valid, set in days (stored as ms). */
  setAppConnectionDays(days: number) {
    this.settings = { ...this.settings, appSessionDuration: days * MS_PER_DAY }
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
    this.#persist()
  }

  disconnectApp(appUrl: string) {
    this.connectedApps = this.connectedApps.map((app) =>
      app.appUrl === appUrl ? revoked(app, false) : app,
    )
    this.#persist()
  }

  /** Disconnect and tombstone so the removal propagates to sync. */
  removeApp(appUrl: string) {
    this.connectedApps = this.connectedApps.map((app) =>
      app.appUrl === appUrl ? revoked(app, true) : app,
    )
    this.#persist()
  }

  // --------------------------------------------------------------------------
  // Drives — owned Swarm storage, each backed by a postage stamp batch (the lib
  // `postageStamps` field). The default is `defaultPostageStampBatchID`.
  // --------------------------------------------------------------------------

  /**
   * Add or replace a drive (deduped by batch id). The first drive added becomes
   * the account default so uploads have something to spend against.
   */
  addDrive(drive: Omit<PostageStamp, 'createdAt'>): PostageStamp {
    const newDrive: PostageStamp = { ...drive, createdAt: Date.now() }
    this.postageStamps = [
      ...this.postageStamps.filter((existing) => !existing.batchID.equals(drive.batchID)),
      newDrive,
    ]
    this.defaultPostageStampBatchID ??= newDrive.batchID
    this.#persist()
    return newDrive
  }

  removeDrive(batchID: BatchId, { skipSync = false }: { skipSync?: boolean } = {}) {
    this.postageStamps = this.postageStamps.filter((drive) => !drive.batchID.equals(batchID))
    // Never leave a default pointing at a drive we just removed; fall back to
    // whatever remains so the account never references a missing batch.
    if (this.defaultPostageStampBatchID?.equals(batchID)) {
      this.defaultPostageStampBatchID = this.postageStamps[0]?.batchID
    }
    this.#persist({ skipSync })
  }

  /** Update a drive's volatile utilization in place, WITHOUT firing sync. */
  updateDriveUtilization(batchID: BatchId, utilization: number) {
    this.postageStamps = this.postageStamps.map((drive) =>
      drive.batchID.equals(batchID) ? { ...drive, utilization } : drive,
    )
    this.#persist({ skipSync: true })
  }

  setDefaultDrive(batchID: BatchId | undefined) {
    this.defaultPostageStampBatchID = batchID
    this.#persist()
  }

  /**
   * Apply state merged from a Swarm refresh, WITHOUT re-publishing (the data
   * came from Swarm).
   */
  applyRefreshed(fields: {
    devices?: Device[]
    connectedApps?: ConnectedApp[]
    postageStamps?: PostageStamp[]
  }) {
    if (fields.devices) this.devices = fields.devices
    if (fields.connectedApps) this.connectedApps = fields.connectedApps
    if (fields.postageStamps) this.postageStamps = fields.postageStamps
    this.#persist({ skipSync: true })
  }
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

// ============================================================================
// Collection store — create / look up / remove whole accounts. Per-account
// state changes live on the Account object itself.
//
// Backed by the `@snaha/swarm-id` Zod storage manager (key STORAGE_KEY_ACCOUNTS)
// — the SAME nested-account document the proxy iframe and sync engine read. The
// product UI, the /dev tooling and sync all drive off this one reactive store.
// ============================================================================

const storageManager = createAccountsStorageManager()

/**
 * Optional sync hook. The /dev sync subsystem injects `triggerSync` so its
 * mutations publish to Swarm; the plain product app leaves it unset, so a
 * rename or app-connect never attempts a network publish.
 */
let syncHook: ((accountIdHex: string) => void) | undefined

export function setAccountsSyncHook(hook: (accountIdHex: string) => void): void {
  syncHook = hook
}

let accounts = $state<Account[]>([])

function persist(): void {
  // Class instances are structurally `LocalAccount`; the lib serializer reads
  // their fields and converts byte classes to hex.
  storageManager.save(accounts)
}

/** Persist the collection and (unless skipped) publish the changed account. */
function onChange(account: Account, options?: { skipSync?: boolean }): void {
  persist()
  if (!options?.skipSync) syncHook?.(account.id.toHex())
}

function hydrate(record: LocalAccount): Account {
  return new Account(record, onChange)
}

function load(): Account[] {
  if (!browser) return []
  // The product UI only manages `local` accounts; ignore any other variant.
  return storageManager
    .load()
    .filter((record): record is LocalAccount => record.type === 'local')
    .map(hydrate)
}

accounts = load()

if (browser) {
  // Cross-tab refresh: another tab mutating the account document (sign-in,
  // app connect, drive purchase) updates this tab's reactive state too.
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY_ACCOUNTS) accounts = load()
  })
}

function toEthAddress(id: string | EthAddress): EthAddress {
  return typeof id === 'string' ? new EthAddress(id) : id
}

export const accountsStore = {
  get accounts(): Account[] {
    return accounts
  },

  /** Re-read from shared storage (e.g. after a direct storage manager write). */
  reload(): void {
    accounts = load()
  },

  get(id: string | EthAddress): Account | undefined {
    const ethId = toEthAddress(id)
    return accounts.find((account) => account.id.equals(ethId))
  },

  /** Alias used by the sync engine / dev tooling (keyed by EthAddress). */
  getAccount(id: EthAddress): Account | undefined {
    return accountsStore.get(id)
  },

  /** Create — or replace, for sign-in / restore — an account; returns the live object. */
  add(record: LocalAccount): Account {
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

  /** Wipe every account from this device (developer reset). */
  clear(): void {
    accounts = []
    storageManager.clear()
  },
}

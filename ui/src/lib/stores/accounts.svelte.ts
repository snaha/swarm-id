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

import { with0x } from '$lib/utils'

const MS_PER_DAY = 24 * 60 * 60 * 1000

type AccountSettings = NonNullable<AccountRecord['settings']>

/**
 * The account aggregate root. Fields are reactive (`$state`) so component reads
 * update on mutation, and every mutator is a method **on the object** that
 * persists the whole collection through the injected `onChange` — callers mutate
 * the account they already hold (`account.addDrive(…)`), never a store method
 * that takes an id and looks the account up.
 *
 * The shape is the shared `@snaha/swarm-id` `Account` record (byte-class fields,
 * serialized to hex by the lib storage manager). A drive is an account's owned
 * Swarm storage, persisted as the lib `postageStamps` field. The private
 * `#onChange` makes the class nominal, so a plain record can't be mistaken for
 * a live account.
 *
 * Scalar fields each carry a per-field last-writer-wins clock
 * (`accountNameAt` / `defaultStampAt` / `settingsAt`) so concurrent edits to
 * different scalars on different devices converge instead of clobbering. The
 * sync engine reads those clocks (`createSyncAccount`), so a mutator that
 * changes a scalar MUST stamp the matching clock.
 */
export class Account {
  readonly id: EthAddress
  readonly createdAt: number
  readonly derivationKey: string
  // Initialized here so the runes compiler tracks them; real values are set
  // from the record in the constructor.
  name = $state('')
  publicKey = $state<string | undefined>(undefined)
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
  readonly #onChange: (account: Account, options?: { skipSync?: boolean }) => void

  constructor(
    record: AccountRecord,
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
    this.accountNameAt = record.accountNameAt
    this.defaultStampAt = record.defaultStampAt
    this.settingsAt = record.settingsAt
    this.lastModified = record.lastModified
    this.partitionCount = record.partitionCount
    this.#onChange = onChange
  }

  #persist(options?: { skipSync?: boolean }) {
    this.#onChange(this, options)
  }

  /** The account id as 0x-prefixed hex — the form the UI shows and copies. */
  get displayId(): string {
    return with0x(this.id.toHex())
  }

  /** Active (non-revoked) connected apps — what the UI displays. */
  get activeApps(): ConnectedApp[] {
    return this.connectedApps.filter((app) => !app.revokedAt)
  }

  /** Live (non-tombstoned) drives — what the UI displays. */
  get drives(): PostageStamp[] {
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

  // --------------------------------------------------------------------------
  // Drives — owned Swarm storage, each backed by a postage stamp batch (the lib
  // `postageStamps` field). The default is `defaultPostageStampBatchID`.
  // --------------------------------------------------------------------------

  /**
   * Add or replace a drive (deduped by batch id). The first drive added becomes
   * the account default so uploads have something to spend against. Re-adding a
   * previously removed batch revives it (a fresh `createdAt` beats the old
   * tombstone on merge).
   */
  addDrive(drive: Omit<PostageStamp, 'createdAt' | 'deletedAt'>): PostageStamp {
    const now = Date.now()
    const newDrive: PostageStamp = { ...drive, createdAt: now }
    this.postageStamps = [
      ...this.postageStamps.filter((existing) => !existing.batchID.equals(drive.batchID)),
      newDrive,
    ]
    if (this.defaultPostageStampBatchID === undefined) {
      this.defaultPostageStampBatchID = newDrive.batchID
      this.defaultStampAt = now
    }
    this.lastModified = now
    this.#persist()
    return newDrive
  }

  /**
   * Tombstone a drive (set `deletedAt`, keep it in the array) so the removal
   * propagates across devices — `mergePostageStamps` keeps the tombstone and
   * lets it beat any peer's stale active copy. A hard delete would be silently
   * re-added on the next fold from a device feed that still has the batch.
   */
  removeDrive(batchID: BatchId) {
    const now = Date.now()
    this.postageStamps = this.postageStamps.map((drive) =>
      drive.batchID.equals(batchID) ? { ...drive, deletedAt: now } : drive,
    )
    // Never leave a default pointing at a drive we just removed; fall back to a
    // remaining live drive so the account never references a deleted batch.
    if (this.defaultPostageStampBatchID?.equals(batchID)) {
      this.defaultPostageStampBatchID = this.postageStamps.find(
        (drive) => drive.deletedAt === undefined,
      )?.batchID
      this.defaultStampAt = now
    }
    this.lastModified = now
    this.#persist()
  }

  /** Update a drive's volatile utilization in place, WITHOUT firing sync. */
  updateDriveUtilization(batchID: BatchId, utilization: number) {
    this.postageStamps = this.postageStamps.map((drive) =>
      drive.batchID.equals(batchID) ? { ...drive, utilization } : drive,
    )
    this.#persist({ skipSync: true })
  }

  setDefaultDrive(batchID: BatchId | undefined) {
    const now = Date.now()
    this.defaultPostageStampBatchID = batchID
    this.defaultStampAt = now
    this.lastModified = now
    this.#persist()
  }

  /**
   * Apply state merged from a Swarm refresh, WITHOUT re-publishing (the data
   * came from Swarm). Collections replace wholesale (already merged upstream).
   * Scalars are folded by per-field LWW: a remote value wins only if its clock
   * is newer than ours, so a stale device can't clobber a local edit.
   */
  applyRefreshed(fields: {
    devices?: Device[]
    connectedApps?: ConnectedApp[]
    postageStamps?: PostageStamp[]
    accountName?: string
    accountNameAt?: number
    defaultPostageStampBatchID?: BatchId | undefined
    defaultStampAt?: number
    settings?: AccountSettings | undefined
    settingsAt?: number
  }) {
    if (fields.devices) this.devices = fields.devices
    if (fields.connectedApps) this.connectedApps = fields.connectedApps
    if (fields.postageStamps) this.postageStamps = fields.postageStamps
    if (
      fields.accountName !== undefined &&
      fields.accountNameAt !== undefined &&
      fields.accountNameAt > (this.accountNameAt ?? this.createdAt)
    ) {
      this.name = fields.accountName
      this.accountNameAt = fields.accountNameAt
    }
    if (
      fields.defaultStampAt !== undefined &&
      fields.defaultStampAt > (this.defaultStampAt ?? this.createdAt)
    ) {
      this.defaultPostageStampBatchID = fields.defaultPostageStampBatchID
      this.defaultStampAt = fields.defaultStampAt
    }
    if (
      fields.settingsAt !== undefined &&
      fields.settingsAt > (this.settingsAt ?? this.createdAt)
    ) {
      this.settings = fields.settings
      this.settingsAt = fields.settingsAt
    }
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

export function setAccountsSyncHook(hook: ((accountIdHex: string) => void) | undefined): void {
  syncHook = hook
}

let accounts = $state<Account[]>([])

function persist(): void {
  // Class instances are structurally `Account` records; the lib serializer
  // reads their fields and converts byte classes to hex.
  storageManager.save(accounts)
}

/** Persist the collection and (unless skipped) publish the changed account. */
function onChange(account: Account, options?: { skipSync?: boolean }): void {
  persist()
  if (!options?.skipSync) syncHook?.(account.id.toHex())
}

function hydrate(record: AccountRecord): Account {
  return new Account(record, onChange)
}

function load(): Account[] {
  if (!browser) return []
  return storageManager.load().map(hydrate)
}

accounts = load()

if (browser) {
  // Cross-tab refresh: another tab mutating the account document (sign-in,
  // app connect, drive purchase) updates this tab's reactive state too.
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY_ACCOUNTS) accounts = load()
  })
}

// EthAddress already accepts both bare and `0x`-prefixed hex, so this is just a
// convenience for the string-keyed call sites (session id, wallet address).
function toEthAddress(id: string | EthAddress): EthAddress {
  return id instanceof EthAddress ? id : new EthAddress(id)
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

  /** Wipe every account from this device (developer reset). */
  clear(): void {
    accounts = []
    storageManager.clear()
  },
}

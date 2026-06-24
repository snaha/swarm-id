// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { AccessMethod, AccountRecord, ConnectedApp, Drive } from '$lib/types'

const STORAGE_KEY = 'swarm-id-accounts-v2'

/**
 * The account aggregate root. Fields are reactive (`$state`) so component reads
 * update on mutation, and every mutator is a method on the object that persists
 * the whole collection through the injected `onChange` — callers mutate the
 * account they already hold (`account.addDrive(…)`), never a store method that
 * takes an id and looks the account up. The account owns its drives and
 * connected apps inline (nested model). `toJSON()` is the plain serialized form.
 */
export class Account {
  readonly id: string
  readonly publicKey: string
  readonly createdAt: number
  // Initialized here so the runes compiler tracks them; real values come from
  // the record in the constructor.
  name = $state('')
  access = $state<AccessMethod>({ type: 'password', kdfSalt: '', kdfIterations: 0 })
  encryptedSeed = $state('')
  appConnectionDays = $state<number | undefined>(undefined)
  defaultDriveBatchId = $state<string | undefined>(undefined)
  drives = $state<Drive[]>([])
  connectedApps = $state<ConnectedApp[]>([])
  readonly #onChange: () => void

  constructor(record: AccountRecord, onChange: () => void) {
    this.id = record.id
    this.publicKey = record.publicKey
    this.createdAt = record.createdAt
    this.name = record.name
    this.access = record.access
    this.encryptedSeed = record.encryptedSeed
    this.appConnectionDays = record.appConnectionDays
    this.defaultDriveBatchId = record.defaultDriveBatchId
    this.drives = record.drives
    this.connectedApps = record.connectedApps
    this.#onChange = onChange
  }

  rename(name: string) {
    this.name = name
    this.#onChange()
  }

  /** Swap the unlock method: new access metadata + seed re-encrypted for it. */
  setAccess(access: AccessMethod, encryptedSeed: string) {
    this.access = access
    this.encryptedSeed = encryptedSeed
    this.#onChange()
  }

  setAppConnectionDays(days: number) {
    this.appConnectionDays = days
    this.#onChange()
  }

  /** Record a (re)connection — replaces any previous entry for the same app. */
  connectApp(app: ConnectedApp) {
    this.connectedApps = [...this.connectedApps.filter((a) => a.appUrl !== app.appUrl), app]
    this.#onChange()
  }

  disconnectApp(appUrl: string) {
    this.connectedApps = this.connectedApps.map((app) =>
      app.appUrl === appUrl ? { ...app, connectedUntil: undefined } : app,
    )
    this.#onChange()
  }

  removeApp(appUrl: string) {
    this.connectedApps = this.connectedApps.filter((app) => app.appUrl !== appUrl)
    this.#onChange()
  }

  /**
   * Add or replace a drive (deduped by batch id). The first drive added becomes
   * the account default so uploads have something to spend against.
   */
  addDrive(drive: Drive) {
    this.drives = [...this.drives.filter((existing) => existing.batchId !== drive.batchId), drive]
    this.defaultDriveBatchId ??= drive.batchId
    this.#onChange()
  }

  removeDrive(batchId: string) {
    this.drives = this.drives.filter((drive) => drive.batchId !== batchId)
    // Drop the default when it points at the removed drive; fall back to
    // whatever remains so the account never references a missing batch.
    if (this.defaultDriveBatchId === batchId) {
      this.defaultDriveBatchId = this.drives[0]?.batchId
    }
    this.#onChange()
  }

  setDefaultDrive(batchId: string | undefined) {
    this.defaultDriveBatchId = batchId
    this.#onChange()
  }

  /** Plain serializable record — used by `JSON.stringify` when persisting. */
  toJSON(): AccountRecord {
    return {
      id: this.id,
      name: this.name,
      publicKey: this.publicKey,
      createdAt: this.createdAt,
      access: this.access,
      encryptedSeed: this.encryptedSeed,
      appConnectionDays: this.appConnectionDays,
      defaultDriveBatchId: this.defaultDriveBatchId,
      drives: this.drives,
      connectedApps: this.connectedApps,
    }
  }
}

let accounts = $state<Account[]>([])

function persist() {
  if (typeof localStorage === 'undefined') {
    return
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts))
}

function hydrate(record: AccountRecord): Account {
  return new Account(record, persist)
}

// Records persisted before the stamp→drive rename used `stamps` /
// `defaultStampBatchId`. Accept either spelling on load and rewrite in the
// current shape on the next persist.
type StoredRecord = AccountRecord & {
  stamps?: Drive[]
  defaultStampBatchId?: string
}

function normalize(record: StoredRecord): AccountRecord {
  return {
    ...record,
    drives: record.drives ?? record.stamps ?? [],
    defaultDriveBatchId: record.defaultDriveBatchId ?? record.defaultStampBatchId,
  }
}

function load(): Account[] {
  if (typeof localStorage === 'undefined') {
    return []
  }
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    return (JSON.parse(raw) as StoredRecord[]).map((record) => hydrate(normalize(record)))
  } catch {
    return []
  }
}

accounts = load()

// Keep tabs in sync: another tab writing accounts updates this one.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      accounts = load()
    }
  })
}

/** The account collection: create / look up / remove whole accounts. Per-account
 * state changes live on the {@link Account} object itself. */
export const accountsStore = {
  get accounts() {
    return accounts
  },
  get(id: string): Account | undefined {
    return accounts.find((account) => account.id === id)
  },
  /** Create — or replace, for sign-in / restore — an account; returns the live object. */
  add(record: AccountRecord): Account {
    const account = hydrate(record)
    accounts = [...accounts.filter((existing) => existing.id !== record.id), account]
    persist()
    return account
  },
  remove(id: string) {
    accounts = accounts.filter((account) => account.id !== id)
    persist()
  },
  /** Wipe every account from this device (developer reset). */
  clear() {
    accounts = []
    persist()
  },
}

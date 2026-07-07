// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, EthAddress } from '@ethersphere/bee-js'
import {
  type AccessMethod,
  type Account as AccountRecord,
  type ConnectedApp,
  type Device,
  type PostageStamp,
  PostageStampSchemaV1,
  STORAGE_KEY_ACCOUNTS,
  createAccountsStorageManager,
  isSignedOutAccount,
  serializePostageStamp,
} from '@snaha/swarm-id'

import { browser } from '$app/environment'

import { daysToMs } from '$lib/duration'

type AccountSettings = { appSessionDuration?: number }

/**
 * The account aggregate root. Fields are reactive (`$state`) so component reads
 * update on mutation, and every mutator is a method **on the object** that
 * commits the whole collection through the injected `#commit` callback — callers
 * mutate the account they already hold (`account.rename(…)`), never a store
 * method that takes an id and looks the account up.
 *
 * The shape is the shared `@snaha/swarm-id` `Account` record (byte-class fields,
 * serialized to hex by the lib storage manager). The private `#commit` makes
 * the class nominal, so a plain record can't be mistaken for a live account.
 *
 * Instances are stable per account id: a cross-tab storage refresh updates the
 * existing instance's fields via `applyRecord` rather than replacing it, so an
 * account held across an await (connect handshake, access change) stays part of
 * the persisted collection and its mutations are never dropped.
 *
 * Scalar fields each carry a per-field last-writer-wins clock
 * (`accountNameAt` / `defaultStampAt` / `settingsAt`) so concurrent edits to
 * different scalars on different devices converge instead of clobbering. A
 * mutator that changes a scalar MUST stamp the matching clock; the /dev sync
 * subsystem folds them by LWW (`applyRefreshed`).
 *
 * Members split into two groups: the product mutators the shipping app calls
 * (including the postage-stamp / "drive" mutators the storage UI drives), and —
 * below the `DEV-ONLY` banner — the volatile-utilization updater and the Swarm
 * refresh fold used **only** by the local `/dev` tooling and sync engine.
 */
export class Account {
  readonly id: EthAddress
  // Initialized here so the runes compiler tracks them; real values are set
  // from the record in the constructor.
  createdAt = $state(0)
  derivationKey = $state('')
  name = $state('')
  publicKey = $state('')
  // The device-local seed vault. Both set while signed in; both wiped (and
  // `signedOutAt` stamped) after `signOut()`.
  access = $state<AccessMethod | undefined>(undefined)
  encryptedSeed = $state<string | undefined>(undefined)
  signedOutAt = $state<number | undefined>(undefined)
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
  // Persist-and-publish this account's change, bound to `this` in the ctor so
  // mutators just call `this.#commit()`. `skipSync: true` saves the collection
  // WITHOUT a Swarm publish (the change came from a remote fold, or is a
  // volatile field peers don't need) — only ever passed by the dev mutators.
  readonly #commit: (options?: { skipSync?: boolean }) => void

  constructor(
    record: AccountRecord,
    commit: (account: Account, options?: { skipSync?: boolean }) => void,
  ) {
    this.id = record.id
    this.#commit = (options) => commit(this, options)
    this.applyRecord(record)
  }

  /**
   * Overwrite this instance's state from a record with the same id. Cross-tab
   * refreshes and same-address re-creation go through this instead of building
   * a new instance, so references held across an await stay live — a mutation
   * on a detached instance would persist a collection that no longer contains
   * it, silently dropping the write.
   */
  applyRecord(record: AccountRecord) {
    this.createdAt = record.createdAt
    this.derivationKey = record.derivationKey
    this.name = record.name
    this.publicKey = record.publicKey
    this.access = record.access
    this.encryptedSeed = record.encryptedSeed
    this.signedOutAt = record.signedOutAt
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
  }

  /** Active (non-revoked) connected apps — what the UI displays. */
  get activeApps(): ConnectedApp[] {
    return this.connectedApps.filter((app) => !app.revokedAt)
  }

  /** Live (non-tombstoned) stamps — what the UI displays (mutators are dev-only, below). */
  get stamps(): PostageStamp[] {
    return this.postageStamps.filter((stamp) => stamp.deletedAt === undefined)
  }

  /** Signed out on this device: the seed vault was wiped by `signOut()`. */
  get isSignedOut(): boolean {
    return isSignedOutAccount(this)
  }

  rename(name: string) {
    const now = Date.now()
    this.name = name
    this.accountNameAt = now
    this.lastModified = now
    this.#commit()
  }

  /** Swap the unlock method: new access metadata + seed re-encrypted for it. */
  setAccess(access: AccessMethod, encryptedSeed: string) {
    this.access = access
    this.encryptedSeed = encryptedSeed
    this.signedOutAt = undefined
    this.lastModified = Date.now()
    this.#commit()
  }

  /**
   * Sign this account out on THIS device: wipe the seed vault and clear the
   * live per-app session material so the dApp proxy can no longer authenticate
   * from here. The row stays in the account list — signing back in requires
   * the recovery phrase and a new access method. Deliberately NOT
   * `disconnectApp` (no `updatedAt` bump): a device-local de-auth must not
   * propagate as a synced disconnect. `skipSync` for the same reason — and
   * with the keys gone there is nothing left to publish with anyway.
   */
  signOut() {
    this.access = undefined
    this.encryptedSeed = undefined
    this.signedOutAt = Date.now()
    this.connectedApps = this.connectedApps.map((app) => ({
      ...app,
      appSecret: undefined,
      connectedUntil: undefined,
    }))
    this.#commit({ skipSync: true })
  }

  /** How long app connections stay valid, set in days (stored as ms). */
  setAppConnectionDays(days: number) {
    const now = Date.now()
    this.settings = { ...this.settings, appSessionDuration: daysToMs(days) }
    this.settingsAt = now
    this.lastModified = now
    this.#commit()
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
    this.#commit()
  }

  disconnectApp(appUrl: string) {
    this.connectedApps = this.connectedApps.map((app) =>
      app.appUrl === appUrl ? revoked(app, false) : app,
    )
    this.lastModified = Date.now()
    this.#commit()
  }

  /** Disconnect and tombstone so the removal propagates to sync. */
  removeApp(appUrl: string) {
    this.connectedApps = this.connectedApps.map((app) =>
      app.appUrl === appUrl ? revoked(app, true) : app,
    )
    this.lastModified = Date.now()
    this.#commit()
  }

  // --------------------------------------------------------------------------
  // Postage stamps ("drives") — keyed by batch id
  //
  // The account owns its stamps as a nested collection. Add / rename / update /
  // remove / set-default are product mutators driven by the storage (drives) UI;
  // the /dev tooling also assigns stamps through them. Only the volatile
  // utilization updater and the sync fold below the DEV-ONLY banner are
  // dev/sync-exclusive.
  // --------------------------------------------------------------------------

  /**
   * Add or replace a stamp (deduped by batch id). The first stamp added becomes
   * the account default so uploads have something to spend against. Re-adding a
   * previously removed batch revives it (a fresh `createdAt` beats the old
   * tombstone on merge).
   */
  addStamp(stamp: Omit<PostageStamp, 'createdAt' | 'deletedAt'>): PostageStamp {
    const now = Date.now()
    const newStamp: PostageStamp = { ...stamp, createdAt: now }
    // Callers build stamps from raw Bee-node JSON. Validate the constructed
    // record BEFORE it enters the collection: one malformed field would make
    // this account's stored record unparseable, so the loader would skip the
    // whole account on the next load. Throws to the caller's error display.
    PostageStampSchemaV1.parse(serializePostageStamp(newStamp))
    this.postageStamps = [
      ...this.postageStamps.filter((existing) => !existing.batchID.equals(stamp.batchID)),
      newStamp,
    ]
    if (this.defaultPostageStampBatchID === undefined) {
      this.defaultPostageStampBatchID = newStamp.batchID
      this.defaultStampAt = now
    }
    this.lastModified = now
    this.#commit()
    return newStamp
  }

  /**
   * Rename a stamp (matched by batch id); no-op if no such LIVE stamp — a
   * tombstoned entry stays untouched so a rename can't mutate (or appear to
   * act on) a drive that was removed meanwhile. `nameUpdatedAt` is the name's
   * own merge clock: it propagates the rename without giving this record any
   * node-state recency (see `mergePostageStamps`).
   */
  renameStamp(batchID: BatchId, name: string) {
    const now = Date.now()
    this.postageStamps = this.postageStamps.map((stamp) =>
      stamp.batchID.equals(batchID) && stamp.deletedAt === undefined
        ? { ...stamp, name, nameUpdatedAt: now }
        : stamp,
    )
    this.lastModified = now
    this.#commit()
  }

  /**
   * Patch a stamp's batch fields after a node-side dilute / top-up (matched by
   * batch id); no-op if no such LIVE stamp (callers verify existence BEFORE
   * spending on the node — see `drive-resize-dialog` / `drive-extend-dialog`).
   * `createdAt` is left untouched (the "purchased on" date stays stable);
   * `updatedAt` carries the edit through the merge so it propagates to other
   * devices instead of tying with stale copies, and doubles as the instant the
   * patched `batchTTL` was measured.
   */
  updateStamp(
    batchID: BatchId,
    patch: Partial<Pick<PostageStamp, 'depth' | 'amount' | 'batchTTL'>>,
  ) {
    const now = Date.now()
    this.postageStamps = this.postageStamps.map((stamp) =>
      stamp.batchID.equals(batchID) && stamp.deletedAt === undefined
        ? { ...stamp, ...patch, updatedAt: now }
        : stamp,
    )
    this.lastModified = now
    this.#commit()
  }

  /** True when the account still has a live (non-tombstoned) stamp for `batchID`. */
  hasLiveStamp(batchID: BatchId): boolean {
    return this.postageStamps.some(
      (stamp) => stamp.batchID.equals(batchID) && stamp.deletedAt === undefined,
    )
  }

  /**
   * Tombstone a stamp (set `deletedAt`, keep it in the array) so the removal
   * propagates across devices — `mergePostageStamps` keeps the tombstone and
   * lets it beat any peer's stale active copy. A hard delete would be silently
   * re-added on the next fold from a device feed that still has the batch.
   */
  removeStamp(batchID: BatchId) {
    const now = Date.now()
    this.postageStamps = this.postageStamps.map((stamp) =>
      stamp.batchID.equals(batchID) ? { ...stamp, deletedAt: now } : stamp,
    )
    // Never leave a default pointing at a stamp we just removed; fall back to a
    // remaining live stamp so the account never references a deleted batch.
    if (this.defaultPostageStampBatchID?.equals(batchID)) {
      this.defaultPostageStampBatchID = this.postageStamps.find(
        (stamp) => stamp.deletedAt === undefined,
      )?.batchID
      this.defaultStampAt = now
    }
    this.lastModified = now
    this.#commit()
  }

  setDefaultStamp(batchID: BatchId | undefined) {
    const now = Date.now()
    this.defaultPostageStampBatchID = batchID
    this.defaultStampAt = now
    this.lastModified = now
    this.#commit()
  }

  // ==========================================================================
  // DEV-ONLY MUTATORS
  //
  // Consumed exclusively by the local-only /dev tooling (`routes/dev`,
  // `lib/dev`) and the sync engine: refreshing a stamp's volatile utilization
  // and folding a hand-triggered Swarm refresh. The shipping app never calls
  // these. They live on the class (not a `lib/dev` free function) because they
  // need the private `#commit` seam.
  // ==========================================================================

  /** Update a stamp's volatile utilization in place, WITHOUT firing sync. */
  updateStampUtilization(batchID: BatchId, utilization: number) {
    this.postageStamps = this.postageStamps.map((stamp) =>
      stamp.batchID.equals(batchID) ? { ...stamp, utilization } : stamp,
    )
    this.#commit({ skipSync: true })
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
    this.#commit({ skipSync: true })
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
// — the SAME nested-account document the proxy iframe and sync engine read. The
// product UI, the /dev tooling and sync all drive off this one reactive store.
// ============================================================================

const storageManager = createAccountsStorageManager()

let accounts = $state<Account[]>([])

/** Save the whole collection to storage — the lib serializer converts the class
 * instances' byte-class fields to hex. No sync. */
function persist(): void {
  storageManager.save(accounts)
}

/**
 * Commit one account's change: `persist()` the collection, then publish this
 * account to Swarm sync — unless `skipSync`, used when the change came from a
 * remote fold or touches only a volatile field peers don't need. Injected into
 * each `Account` as its `#commit`.
 */
function commitAccount(account: Account, options?: { skipSync?: boolean }): void {
  persist()
  if (!options?.skipSync) syncHook?.(account.id.toHex())
}

function hydrate(record: AccountRecord): Account {
  return new Account(record, commitAccount)
}

function load(): Account[] {
  if (!browser) return []
  return storageManager.load().map(hydrate)
}

accounts = load()

/**
 * Re-read the collection from storage, updating existing instances in place
 * (see `applyRecord`) so held references survive the refresh.
 */
function refresh(): void {
  accounts = storageManager.load().map((record) => {
    const existing = accounts.find((account) => account.id.equals(record.id))
    if (!existing) return hydrate(record)
    existing.applyRecord(record)
    return existing
  })
}

if (browser) {
  // Cross-tab refresh: another tab mutating the account document (sign-in,
  // app connect, stamp purchase) updates this tab's reactive state too.
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY_ACCOUNTS) refresh()
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
    const existing = accounts.find((account) => account.id.equals(record.id))
    if (existing) {
      // Reuse the instance so references held elsewhere keep working.
      existing.applyRecord(record)
      persist()
      return existing
    }
    const account = hydrate(record)
    accounts = [...accounts, account]
    persist()
    return account
  },

  remove(id: string | EthAddress): void {
    const ethId = toEthAddress(id)
    accounts = accounts.filter((account) => !account.id.equals(ethId))
    persist()
  },

  // ----- Dev-only: consumed only by the /dev tooling (see the class banner) ---

  /** `EthAddress`-typed lookup used by the /dev tooling and sync engine. */
  getAccount(id: EthAddress): Account | undefined {
    return accountsStore.get(id)
  },

  /** Wipe every account from this device (developer reset). */
  clear(): void {
    accounts = []
    storageManager.clear()
  },
}

// ----------------------------------------------------------------------------
// Dev-only sync seam — consumed only by the /dev sync subsystem.
//
// The plain product app leaves the hook unset, so a rename or app-connect never
// attempts a network publish; the /dev page sets `triggerSync` in onMount so its
// mutations publish to Swarm.
// ----------------------------------------------------------------------------

let syncHook: ((accountIdHex: string) => void) | undefined

export function setAccountsSyncHook(hook: ((accountIdHex: string) => void) | undefined): void {
  syncHook = hook
}

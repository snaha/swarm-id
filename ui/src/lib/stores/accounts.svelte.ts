// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, EthAddress } from '@ethersphere/bee-js'
import {
  type AccessMethod,
  type Account as AccountRecord,
  type ConnectedApp,
  type Device,
  type LocalVault,
  type PostageStamp,
  PostageStampSchemaV1,
  STORAGE_KEY_ACCOUNTS,
  type SyncedAccount,
  createAccountsStorageManager,
  isSignedOutAccount,
  serializePostageStamp,
} from '@snaha/swarm-id'

import { browser } from '$app/environment'

import { drivesNeedingAttention, soonestDriveExpiry } from '$lib/drives'
import { daysToMs } from '$lib/duration'

type AccountSettings = { appSessionDuration?: number }

/**
 * The device-local tail of the account record, mirroring the lib's `Account`
 * union: the seed vault — which SURVIVES a sign-out so the user can sign back
 * in with the existing access method — plus, while signed out, the sign-out
 * marker and the encrypted snapshot of the synced state (restored on
 * sign-back-in). Held as ONE union-typed field so a signed-out state without
 * its snapshot is unrepresentable.
 */
type DeviceAuth =
  | {
      vault: LocalVault
      signedOutAt?: undefined
      encryptedState?: undefined
      storageWarning?: undefined
      soonestDriveExpiry?: undefined
    }
  | {
      vault: LocalVault
      signedOutAt: number
      encryptedState: string
      /** Any drive needed attention when the sign-out captured the state. */
      storageWarning?: boolean
      /** Soonest estimated drive expiry (epoch ms) captured at sign-out. */
      soonestDriveExpiry?: number
    }

/**
 * The account aggregate root. Fields are reactive (`$state`) so component reads
 * update on mutation, and every mutator is a method **on the object** that
 * commits the whole collection through the injected `#commit` callback — callers
 * mutate the account they already hold (`account.rename(…)`), never a store
 * method that takes an id and looks the account up.
 *
 * The shape mirrors the shared `@snaha/swarm-id` `Account` record union —
 * `applyRecord`/`toRecord` project from/to it (byte-class fields are serialized
 * to hex by the lib storage manager). The private `#commit` makes the class
 * nominal, so a plain record can't be mistaken for a live account.
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
  // Device-local auth state: the seed vault plus the sign-out marker (exposed
  // via the getters below). The placeholder is overwritten by `applyRecord` in
  // the constructor before any read.
  #deviceAuth = $state<DeviceAuth>({
    vault: { access: { type: 'password', kdfSalt: '', kdfIterations: 0 }, encryptedSeed: '' },
  })
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
  // WITHOUT a Swarm publish: the change came from a remote fold, is a volatile
  // field peers don't need, or is a device-local de-auth that must not
  // propagate (`signOut`).
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
    this.name = record.name
    const vault = { access: record.access, encryptedSeed: record.encryptedSeed }
    if (isSignedOutAccount(record)) {
      // The stored record is the minimal sign-out remnant — no synced fields.
      this.#deviceAuth = {
        vault,
        signedOutAt: record.signedOutAt,
        encryptedState: record.encryptedState,
        storageWarning: record.storageWarning,
        soonestDriveExpiry: record.soonestDriveExpiry,
      }
      this.#resetSyncedFields()
      return
    }
    this.#deviceAuth = { vault }
    this.derivationKey = record.derivationKey
    this.publicKey = record.publicKey
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

  /**
   * Reset every synced field to its empty default — a signed-out account keeps
   * only the vault and display fields, in memory as on disk, so no stale (or
   * secret: `derivationKey`) synced data lingers past a sign-out.
   */
  #resetSyncedFields() {
    this.derivationKey = ''
    this.publicKey = ''
    this.settings = undefined
    this.defaultPostageStampBatchID = undefined
    this.devices = []
    this.connectedApps = []
    this.postageStamps = []
    this.accountNameAt = undefined
    this.defaultStampAt = undefined
    this.settingsAt = undefined
    this.lastModified = undefined
    this.partitionCount = undefined
  }

  /**
   * Project the live instance back onto the lib's `Account` record union —
   * `applyRecord`'s inverse, what `persist()` hands the storage manager. The
   * union return type makes a half-signed-out projection a type error.
   */
  toRecord(): AccountRecord {
    const auth = this.#deviceAuth
    if (auth.signedOutAt !== undefined) {
      // The minimal sign-out remnant — display fields, the retained vault,
      // the encrypted snapshot, and the storage-warning remnant.
      return {
        id: this.id,
        name: this.name,
        createdAt: this.createdAt,
        ...auth.vault,
        encryptedState: auth.encryptedState,
        storageWarning: auth.storageWarning,
        soonestDriveExpiry: auth.soonestDriveExpiry,
        signedOutAt: auth.signedOutAt,
      }
    }
    const { vault } = auth
    return { ...this.toSyncedRecord(), ...vault }
  }

  /**
   * The synced (vault-less) projection of this account — what travels to
   * other devices, and what the connect popup hands a storage-partitioned
   * proxy iframe (via `serializeSyncedAccount`, which also strips app
   * secrets).
   */
  toSyncedRecord(): SyncedAccount {
    return {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      derivationKey: this.derivationKey,
      publicKey: this.publicKey,
      settings: this.settings,
      defaultPostageStampBatchID: this.defaultPostageStampBatchID,
      devices: this.devices,
      connectedApps: this.connectedApps,
      postageStamps: this.postageStamps,
      accountNameAt: this.accountNameAt,
      defaultStampAt: this.defaultStampAt,
      settingsAt: this.settingsAt,
      lastModified: this.lastModified,
      partitionCount: this.partitionCount,
    }
  }

  /** Active (non-revoked) connected apps — what the UI displays. */
  get activeApps(): ConnectedApp[] {
    return this.connectedApps.filter((app) => !app.revokedAt)
  }

  /** Live (non-tombstoned) stamps — what the UI displays (mutators are dev-only, below). */
  get stamps(): PostageStamp[] {
    return this.postageStamps.filter((stamp) => stamp.deletedAt === undefined)
  }

  /** Local: no live drives, so nothing of this account lives on Swarm yet. */
  get isLocal(): boolean {
    return this.stamps.length === 0
  }

  /** Device-local seed vault — survives a sign-out (encrypted at rest). */
  get vault(): LocalVault {
    return this.#deviceAuth.vault
  }

  /**
   * How the seed is unlocked on this device. Always present — the vault
   * survives a sign-out, which is what lets the sign-back-in ceremony unlock
   * with the existing method instead of the recovery phrase.
   */
  get accessMethod(): AccessMethod {
    return this.#deviceAuth.vault.access
  }

  /** When `signOut()` stripped the synced data; `undefined` while signed in. */
  get signedOutAt(): number | undefined {
    return this.#deviceAuth.signedOutAt
  }

  /**
   * The encrypted snapshot of the synced state a sign-out kept; `undefined`
   * while signed in. Sign-back-in decrypts and restores it.
   */
  get encryptedState(): string | undefined {
    return this.#deviceAuth.encryptedState
  }

  /** Whether any drive needed attention when the sign-out captured the state. */
  get storageWarning(): boolean | undefined {
    return this.#deviceAuth.storageWarning
  }

  /** Soonest estimated drive expiry (epoch ms) captured at sign-out. */
  get soonestDriveExpiry(): number | undefined {
    return this.#deviceAuth.soonestDriveExpiry
  }

  /**
   * Signed out on this device: `signOut()` stripped the synced data, but the
   * vault remains — unlocking it signs back in.
   */
  get isSignedOut(): boolean {
    return this.#deviceAuth.signedOutAt !== undefined
  }

  rename(name: string) {
    const now = Date.now()
    this.name = name
    this.accountNameAt = now
    this.lastModified = now
    this.#commit()
  }

  /**
   * Swap the unlock method: new access metadata + seed re-encrypted for it.
   * Throws on a signed-out account — a late change-method ceremony landing
   * here would silently undo the sign-out. Sign back in first (the
   * sign-back-in flow replaces the whole record via `accountsStore.add`).
   */
  setAccess(access: AccessMethod, encryptedSeed: string) {
    if (this.isSignedOut) {
      throw new Error(
        'Cannot set an access method: this account is signed out on this device. Sign back in first.',
      )
    }
    this.#deviceAuth = { vault: { access, encryptedSeed } }
    this.lastModified = Date.now()
    this.#commit()
  }

  /**
   * Sign this account out on THIS device: keep the encrypted seed vault (so
   * signing back in only takes the access method) but strip every synced
   * field — including the secret `derivationKey` and the live per-app session
   * material the dApp proxy authenticates from. What is stripped survives as
   * `encryptedState`, the AES-encrypted snapshot the caller built from this
   * account BEFORE calling (encryption is async WebCrypto; this mutator stays
   * synchronous), so sign-back-in can restore losslessly without the network.
   * The row stays in the account list as a minimal remnant. `skipSync`: a
   * device-local de-auth must not propagate, and the record no longer carries
   * anything to publish with.
   */
  signOut(encryptedState: string) {
    // Capture the storage-warning remnant BEFORE the stamps are stripped: the
    // chooser must keep warning about full/expiring drives while the stamps
    // themselves are only in the encrypted snapshot.
    this.#deviceAuth = {
      vault: this.#deviceAuth.vault,
      signedOutAt: Date.now(),
      encryptedState,
      storageWarning: drivesNeedingAttention(this) > 0,
      soonestDriveExpiry: soonestDriveExpiry(this.stamps),
    }
    this.#resetSyncedFields()
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

  /**
   * Point an app at a specific drive — or back at the account default with
   * `undefined`. `updatedAt` carries the choice through the cross-device
   * merge. No-op when the app has no entry (nothing to point).
   */
  setAppStamp(appUrl: string, batchID: BatchId | undefined) {
    if (!this.connectedApps.some((app) => app.appUrl === appUrl)) {
      return
    }
    const now = Date.now()
    this.connectedApps = this.connectedApps.map((app) =>
      app.appUrl === appUrl ? { ...app, postageStampBatchID: batchID, updatedAt: now } : app,
    )
    this.lastModified = now
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

/**
 * Persist one account by read-merge-write: re-read the stored collection and
 * overwrite ONLY this account's record (the live instance projected back onto
 * the record union via `toRecord`), so a save→save interleaving with another
 * tab mutating a DIFFERENT account can't clobber that tab's write (in-memory
 * convergence still comes from the cross-tab `storage` event).
 * Accepted edge: merging by id means a mutation racing another tab's remove of
 * the SAME account re-adds it — benign, last-writer-wins. No sync.
 */
function persistAccount(account: Account): void {
  const record = account.toRecord()
  const stored = storageManager.load()
  const merged = stored.some((existing) => existing.id.equals(account.id))
    ? stored.map((existing) => (existing.id.equals(account.id) ? record : existing))
    : [...stored, record]
  storageManager.save(merged)
}

/** Remove one account from storage by read-merge-write (see `persistAccount`). */
function persistRemoval(id: EthAddress): void {
  storageManager.save(storageManager.load().filter((record) => !record.id.equals(id)))
}

/**
 * Commit one account's change: `persist()` the collection, then publish this
 * account to Swarm sync — unless `skipSync`, used when the change came from a
 * remote fold or touches only a volatile field peers don't need. Injected into
 * each `Account` as its `#commit`.
 */
function commitAccount(account: Account, options?: { skipSync?: boolean }): void {
  persistAccount(account)
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

function toEthAddress(id: string | EthAddress): EthAddress | undefined {
  // `EthAddress` parses a bare or `0x`-prefixed hex string, so a raw stored id
  // and a caller's `.toHex()` both work. `undefined` on malformed input: ids
  // arrive from localStorage (`swarm-id-current-account-v2`) inside render-time
  // `$derived`s, so a tampered value must fall through to the "no account"
  // paths instead of white-screening every page.
  if (typeof id !== 'string') return id
  try {
    return new EthAddress(id)
  } catch {
    return undefined
  }
}

export const accountsStore = {
  get accounts(): Account[] {
    return accounts
  },

  get(id: string | EthAddress): Account | undefined {
    const ethId = toEthAddress(id)
    return ethId && accounts.find((account) => account.id.equals(ethId))
  },

  /** Create — or replace, for sign-in / restore — an account; returns the live object. */
  add(record: AccountRecord): Account {
    const existing = accounts.find((account) => account.id.equals(record.id))
    if (existing) {
      // Reuse the instance so references held elsewhere keep working.
      existing.applyRecord(record)
      persistAccount(existing)
      return existing
    }
    const account = hydrate(record)
    accounts = [...accounts, account]
    persistAccount(account)
    return account
  },

  remove(id: string | EthAddress): void {
    const ethId = toEthAddress(id)
    if (!ethId) return
    accounts = accounts.filter((account) => !account.id.equals(ethId))
    persistRemoval(ethId)
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
// Propagation seam — "this change should reach other contexts".
//
// Wired app-wide in `+layout.svelte` (#389; it was dev-only before that), and
// it now drives two publishers: the Swarm feed write for durability, and the
// account bus for the live contexts a `storage` event cannot reach — a
// partitioned dApp iframe learns about a revoke no other way.
//
// `skipSync` therefore means "peers must not hear about this": a change folded
// FROM a peer (re-publishing it is an echo loop), or a volatile field nobody
// else needs.
// ----------------------------------------------------------------------------

let syncHook: ((accountIdHex: string) => void) | undefined

export function setAccountsSyncHook(hook: ((accountIdHex: string) => void) | undefined): void {
  syncHook = hook
}

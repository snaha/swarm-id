// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * SyncedAccount — aggregate root for one account.
 *
 * PROTOTYPE: demonstrates the "accounts handle their own change" model as an
 * alternative to the sync coordinator. The account is the single entry point
 * for mutating its identities / apps / stamps, so each method *declares its own
 * sync intent*: meaningful changes call #sync(); volatile ones (utilization)
 * and deletion do not. No fingerprinting, no central diff — the method knows
 * what it changed.
 *
 * This is a thin reactive facade over the existing flat stores: it owns the
 * behavior and persists *through* the stores, so the localStorage shape (and
 * the iframe proxy that reads it) is unchanged. A full aggregate would also own
 * persistence; that's a larger migration into the shared lib and is out of
 * scope for this prototype.
 */

import { EthAddress, BatchId } from '@ethersphere/bee-js'
import {
  collectAccountStampBatchIds,
  type Account,
  type Identity,
  type ConnectedApp,
  type PostageStamp,
  type Device,
} from '@snaha/swarm-id'
import { accountsStore } from '$lib/stores/accounts.svelte'
import { identitiesStore } from '$lib/stores/identities.svelte'
import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
import { triggerSync } from '$lib/utils/sync-hooks'

type ConnectAppInput = Omit<ConnectedApp, 'lastConnectedAt'> & {
  appIcon?: string
  appDescription?: string
  appSecret?: string
}

export class SyncedAccount {
  readonly id: EthAddress

  constructor(id: EthAddress) {
    this.id = id
  }

  // --------------------------------------------------------------------------
  // Reactive reads (delegate to the stores — reactivity flows through)
  // --------------------------------------------------------------------------

  get raw(): Account | undefined {
    return accountsStore.getAccount(this.id)
  }

  get exists(): boolean {
    return this.raw !== undefined
  }

  get name(): string {
    return this.raw?.name ?? ''
  }

  get defaultStamp(): BatchId | undefined {
    return this.raw?.defaultPostageStampBatchID
  }

  get identities(): Identity[] {
    return identitiesStore.getIdentitiesByAccount(this.id)
  }

  get apps(): ConnectedApp[] {
    return this.identities.flatMap((identity) =>
      connectedAppsStore.getAppsByIdentityId(identity.id),
    )
  }

  get stamps(): PostageStamp[] {
    const account = this.raw
    if (!account) return []
    return collectAccountStampBatchIds(account, this.identities)
      .map((batchId) => postageStampsStore.getStamp(batchId))
      .filter((stamp): stamp is PostageStamp => stamp !== undefined)
  }

  // --------------------------------------------------------------------------
  // Account-level mutations
  // --------------------------------------------------------------------------

  rename(name: string): void {
    accountsStore.setAccountName(this.id, name)
    this.#sync()
  }

  setDefaultStamp(batchID: BatchId | undefined): void {
    accountsStore.setDefaultStamp(this.id, batchID)
    this.#sync()
  }

  updateDevices(devices: Device[]): void {
    accountsStore.updateDevices(this.id, devices)
    this.#sync()
  }

  // --------------------------------------------------------------------------
  // Identity mutations
  // --------------------------------------------------------------------------

  addIdentity(identity: Omit<Identity, 'createdAt'>): Identity {
    const created = identitiesStore.addIdentity(identity)
    this.#sync()
    return created
  }

  removeIdentity(identityId: string): void {
    identitiesStore.removeIdentity(identityId)
    this.#sync()
  }

  updateIdentity(identityId: string, update: Partial<Identity>): void {
    identitiesStore.updateIdentity(identityId, update)
    this.#sync()
  }

  setIdentityDefaultStamp(identityId: string, batchID: BatchId | undefined): void {
    identitiesStore.setDefaultStamp(identityId, batchID)
    this.#sync()
  }

  // --------------------------------------------------------------------------
  // Connected app mutations
  // --------------------------------------------------------------------------

  connectApp(appData: ConnectAppInput, defaultConnectionTime: number | undefined): ConnectedApp {
    const app = connectedAppsStore.addOrUpdateApp(appData, defaultConnectionTime)
    this.#sync()
    return app
  }

  removeApp(appUrl: string, identityId: string): void {
    connectedAppsStore.removeApp(appUrl, identityId)
    this.#sync()
  }

  disconnectApp(appUrl: string, identityId: string): void {
    connectedAppsStore.disconnectApp(appUrl, identityId)
    this.#sync()
  }

  // --------------------------------------------------------------------------
  // Stamp mutations
  // --------------------------------------------------------------------------

  addStamp(stamp: Omit<PostageStamp, 'createdAt'>): PostageStamp {
    const added = postageStampsStore.addStamp(stamp)
    this.#sync()
    return added
  }

  removeStamp(batchID: BatchId): void {
    postageStampsStore.removeStamp(batchID)
    this.#sync()
  }

  /**
   * Volatile: sync writes utilization back, so this must NOT trigger a sync —
   * otherwise sync → utilization write → sync would loop. Expressing that here
   * is simply "this method doesn't call #sync()", with no fingerprint exclusion.
   */
  updateStampUtilization(batchID: BatchId, utilization: number): void {
    postageStampsStore.updateStampUtilization(batchID, utilization)
  }

  // --------------------------------------------------------------------------
  // Deletion — local-only, never syncs (leaves the Swarm backup intact)
  // --------------------------------------------------------------------------

  delete(): void {
    const account = this.raw
    const identities = this.identities
    // Collect stamp batch ids before removing identities, since the
    // association is derived from the account/identity pointers.
    const stampBatchIds = account ? collectAccountStampBatchIds(account, identities) : []

    for (const identity of identities) {
      connectedAppsStore.removeAppsByIdentityId(identity.id)
      identitiesStore.removeIdentity(identity.id)
    }
    for (const batchId of stampBatchIds) {
      postageStampsStore.removeStamp(batchId)
    }
    accountsStore.removeAccount(this.id)
    // Intentionally no #sync(): deletion is local-only.
  }

  #sync(): void {
    triggerSync(this.id.toHex())
  }
}

// Stable instance per account id, so callers and Svelte get referential identity.
const cache = new Map<string, SyncedAccount>()

/**
 * Get the aggregate for an account id (creating a stable instance on first use).
 */
export function getSyncedAccount(id: EthAddress): SyncedAccount {
  const key = id.toHex()
  let account = cache.get(key)
  if (!account) {
    account = new SyncedAccount(id)
    cache.set(key, account)
  }
  return account
}

/**
 * Create a brand-new account and return its aggregate. Mirrors the data path of
 * accountsStore.addAccount, then syncs (a no-op until the account has a stamp).
 */
export function createSyncedAccount(account: Account): SyncedAccount {
  accountsStore.addAccount(account)
  const aggregate = getSyncedAccount(account.id)
  triggerSync(account.id.toHex())
  return aggregate
}

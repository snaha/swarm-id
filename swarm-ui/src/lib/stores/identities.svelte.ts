// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { browser } from '$app/environment'
import { EthAddress, BatchId } from '@ethersphere/bee-js'
import { createIdentitiesStorageManager, type Identity } from '@snaha/swarm-id'
import { triggerSync } from '$lib/utils/sync-hooks'
import { sessionStore } from './session.svelte'

// ============================================================================
// Storage Manager
// ============================================================================

const storageManager = createIdentitiesStorageManager()

function loadIdentities(): Identity[] {
  if (!browser) return []
  return storageManager.load()
}

function saveIdentities(data: Identity[]): void {
  storageManager.save(data)

  // Trigger Swarm sync for current identity's account
  const currentIdentityId = sessionStore.data.currentIdentityId
  if (currentIdentityId) {
    const identity = data.find((i) => i.id === currentIdentityId)
    if (identity) {
      triggerSync(identity.accountId.toHex())
    }
  }
}

// ============================================================================
// Reactive Store
// ============================================================================

let identities = $state<Identity[]>(loadIdentities())

export const identitiesStore = {
  get identities() {
    return identities
  },

  addIdentity(identity: Omit<Identity, 'createdAt'>): Identity {
    const newIdentity: Identity = {
      ...identity,
      createdAt: Date.now(),
    }
    identities = [...identities, newIdentity]
    saveIdentities(identities)
    return newIdentity
  },

  removeIdentity(id: string) {
    identities = identities.filter((i) => i.id !== id)
    saveIdentities(identities)
  },

  getIdentity(id: string): Identity | undefined {
    return identities.find((i) => i.id === id)
  },

  getIdentitiesByAccount(accountId: EthAddress): Identity[] {
    return identities.filter((i) => i.accountId.equals(accountId))
  },

  setDefaultStamp(identityId: string, batchID: BatchId | undefined) {
    identities = identities.map((i) =>
      i.id === identityId
        ? {
            ...i,
            defaultPostageStampBatchID: batchID,
          }
        : i,
    )
    saveIdentities(identities)
  },

  updateIdentity(identityId: string, update: Partial<Identity>) {
    identities = identities.map((i) => (i.id === identityId ? { ...i, ...update } : i))
    saveIdentities(identities)
  },

  /**
   * Replace an account's identities with a freshly-merged set pulled from
   * Swarm, WITHOUT firing `triggerSync` — the data came from a refresh, so
   * re-publishing it would be wasted bandwidth and could clobber a peer write.
   */
  applyRefreshed(accountId: EthAddress, accountIdentities: Identity[]) {
    identities = [...identities.filter((i) => !i.accountId.equals(accountId)), ...accountIdentities]
    storageManager.save(identities)
  },

  clear() {
    identities = []
    storageManager.clear()
  },
}

// Cross-context sync: when another same-origin context changes identities,
// refresh our in-memory copy and publish for each affected account. The cross-
// tab write lock serializes uploads to a single writer. Loop-safe: a publish
// reads identities but never writes them.
if (browser) {
  storageManager.subscribe((ids) => {
    identities = ids
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral set
    const accountIds = new Set<string>()
    for (const identity of ids) {
      accountIds.add(identity.accountId.toHex())
    }
    for (const accountId of accountIds) {
      triggerSync(accountId)
    }
  })
}

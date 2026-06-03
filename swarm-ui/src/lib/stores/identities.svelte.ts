// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { browser } from '$app/environment'
import { EthAddress, BatchId } from '@ethersphere/bee-js'
import { createIdentitiesStorageManager, type Identity } from '@snaha/swarm-id'

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

  clear() {
    identities = []
    storageManager.clear()
  },
}

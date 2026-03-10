import { browser } from '$app/environment'
import { EthAddress, BatchId } from '@ethersphere/bee-js'
import { createIdentitiesStorageManager, type Identity } from '@swarm-id/lib'
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

  addIdentity(identity: Omit<Identity, 'id' | 'createdAt'> & { id?: string }): Identity {
    const newIdentity: Identity = {
      ...identity,
      id: identity.id ?? crypto.randomUUID(),
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

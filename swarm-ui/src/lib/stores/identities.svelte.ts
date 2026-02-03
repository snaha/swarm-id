import { browser } from '$app/environment'
import { EthAddress, BatchId } from '@ethersphere/bee-js'
import { createIdentitiesStorageManager, type Identity } from '@swarm-id/lib'
import { triggerSync } from '$lib/utils/sync-hooks'

// ============================================================================
// Storage Manager
// ============================================================================

const storageManager = createIdentitiesStorageManager()

function loadIdentities(): Identity[] {
	if (!browser) return []
	return storageManager.load()
}

function saveIdentities(data: Identity[], accountId?: string): void {
	storageManager.save(data)

	if (accountId) {
		triggerSync(accountId)
	}
}

// ============================================================================
// Reactive Store
// ============================================================================

let identities = $state<Identity[]>(loadIdentities())

// Subscribe to cross-tab storage changes (fires in OTHER tabs when localStorage changes)
if (browser) {
	storageManager.subscribe((updatedData) => {
		identities = updatedData
	})
}

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
		saveIdentities(identities, newIdentity.accountId.toHex())
		return newIdentity
	},

	removeIdentity(id: string) {
		const identity = identities.find((i) => i.id === id)
		identities = identities.filter((i) => i.id !== id)
		saveIdentities(identities, identity?.accountId.toHex())
	},

	getIdentity(id: string): Identity | undefined {
		return identities.find((i) => i.id === id)
	},

	getIdentitiesByAccount(accountId: EthAddress): Identity[] {
		return identities.filter((i) => i.accountId.equals(accountId))
	},

	setDefaultStamp(identityId: string, batchID: BatchId | undefined) {
		const identity = identities.find((i) => i.id === identityId)
		identities = identities.map((i) =>
			i.id === identityId
				? {
						...i,
						defaultPostageStampBatchID: batchID,
					}
				: i,
		)
		saveIdentities(identities, identity?.accountId.toHex())
	},

	updateIdentity(identityId: string, update: Partial<Identity>) {
		const identity = identities.find((i) => i.id === identityId)
		identities = identities.map((i) => (i.id === identityId ? { ...i, ...update } : i))
		saveIdentities(identities, identity?.accountId.toHex())
	},

	clear() {
		identities = []
		storageManager.clear()
	},
}

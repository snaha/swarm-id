import { z } from 'zod'
import { browser } from '$app/environment'
import { EthAddress, BatchId } from '@ethersphere/bee-js'
import { VersionedStorageSchema } from '$lib/schemas'
import { type Identity, IdentitySchemaV1 } from '$lib/types'

// ============================================================================
// Storage
// ============================================================================

const STORAGE_KEY = 'swarm-identities'
const CURRENT_VERSION = 1

// ============================================================================
// Storage (versioned)
// ============================================================================

function loadIdentities(): Identity[] {
	if (!browser) return []
	const stored = localStorage.getItem(STORAGE_KEY)
	if (!stored) return []

	try {
		const parsed: unknown = JSON.parse(stored)
		return parse(parsed)
	} catch (e) {
		console.error('[Identities] Load failed:', e)
		return []
	}
}

function parse(parsed: unknown): Identity[] {
	const versioned = VersionedStorageSchema.safeParse(parsed)
	const version = versioned.success ? versioned.data.version : 0
	const data = versioned.success ? versioned.data.data : parsed

	switch (version) {
		case 0: // Legacy unversioned data
		case 1: {
			const result = z.array(IdentitySchemaV1).safeParse(data)
			if (!result.success) {
				console.error('[Identities] Invalid data:', result.error.format())
				return []
			}
			return result.data
		}
		default:
			console.error(`[Identities] Unknown version: ${version}`)
			return []
	}
}

/**
 * Serialize identity for storage (convert Bytes instances to hex strings)
 */
function serializeIdentity(identity: Identity): Record<string, unknown> {
	return {
		id: identity.id,
		accountId: identity.accountId.toHex(),
		name: identity.name,
		defaultPostageStampBatchID: identity.defaultPostageStampBatchID?.toHex(),
		createdAt: identity.createdAt,
	}
}

function saveIdentities(data: Identity[]): void {
	if (!browser) return
	const serialized = data.map(serializeIdentity)
	localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: CURRENT_VERSION, data: serialized }))
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
		if (browser) localStorage.removeItem(STORAGE_KEY)
	},
}

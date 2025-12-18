import { z } from 'zod'
import { browser } from '$app/environment'
import {
	EthAddressSchema,
	TimestampSchema,
	BatchIdSchema,
	VersionedStorageSchema,
} from '$lib/schemas'

// ============================================================================
// Schema & Types
// ============================================================================

const STORAGE_KEY = 'swarm-identities'
const CURRENT_VERSION = 1

const IdentitySchemaV1 = z.object({
	id: z.string().min(1),
	accountId: EthAddressSchema,
	name: z.string().min(1).max(100),
	defaultPostageStampBatchID: BatchIdSchema.optional(),
	createdAt: TimestampSchema,
})

export type Identity = z.infer<typeof IdentitySchemaV1>

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

function saveIdentities(data: Identity[]): void {
	if (!browser) return
	localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: CURRENT_VERSION, data }))
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

	getIdentitiesByAccount(accountId: string): Identity[] {
		return identities.filter((i) => i.accountId === accountId)
	},

	setDefaultStamp(identityId: string, batchID: string | undefined) {
		identities = identities.map((i) =>
			i.id === identityId ? { ...i, defaultPostageStampBatchID: batchID } : i,
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

export type Identity = {
	id: string
	accountId: string
	name: string
	createdAt: number
}

const STORAGE_KEY = 'swarm-identities'

// Load identities from localStorage
function loadIdentities(): Identity[] {
	if (typeof window === 'undefined') return []
	const stored = localStorage.getItem(STORAGE_KEY)
	return stored ? JSON.parse(stored) : []
}

// Save identities to localStorage
function saveIdentities(identities: Identity[]) {
	if (typeof window === 'undefined') return
	localStorage.setItem(STORAGE_KEY, JSON.stringify(identities))
}

// Reactive state using Svelte 5 runes
let identities = $state<Identity[]>(loadIdentities())

export const identitiesStore = {
	get identities() {
		return identities
	},

	addIdentity(identity: Omit<Identity, 'id' | 'createdAt'>): Identity {
		const newIdentity: Identity = {
			...identity,
			id: crypto.randomUUID(),
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

	clear() {
		identities = []
		saveIdentities(identities)
	},
}

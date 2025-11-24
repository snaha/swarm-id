export type PostageStamp = {
	id: string
	identityId: string
	batchID: string
	utilization: number
	usable: boolean
	depth: number
	amount: string
	bucketDepth: number
	blockNumber: number
	immutableFlag: boolean
	exists: boolean
	batchTTL?: number
	createdAt: number
}

const STORAGE_KEY = 'swarm-postage-stamps'

// Load postage stamps from localStorage
function loadPostageStamps(): PostageStamp[] {
	if (typeof window === 'undefined') return []
	const stored = localStorage.getItem(STORAGE_KEY)
	return stored ? JSON.parse(stored) : []
}

// Save postage stamps to localStorage
function savePostageStamps(stamps: PostageStamp[]) {
	if (typeof window === 'undefined') return
	localStorage.setItem(STORAGE_KEY, JSON.stringify(stamps))
}

// Reactive state using Svelte 5 runes
let postageStamps = $state<PostageStamp[]>(loadPostageStamps())

export const postageStampsStore = {
	get stamps() {
		return postageStamps
	},

	addStamp(stamp: Omit<PostageStamp, 'id' | 'createdAt'>): PostageStamp {
		const newStamp: PostageStamp = {
			...stamp,
			id: crypto.randomUUID(),
			createdAt: Date.now(),
		}
		postageStamps = [...postageStamps, newStamp]
		savePostageStamps(postageStamps)
		return newStamp
	},

	removeStamp(id: string) {
		postageStamps = postageStamps.filter((s) => s.id !== id)
		savePostageStamps(postageStamps)
	},

	getStamp(id: string): PostageStamp | undefined {
		return postageStamps.find((s) => s.id === id)
	},

	getStampsByIdentity(identityId: string): PostageStamp[] {
		return postageStamps.filter((s) => s.identityId === identityId)
	},

	clear() {
		postageStamps = []
		savePostageStamps(postageStamps)
	},
}

import { browser } from '$app/environment'
import { BatchId } from '@ethersphere/bee-js'
import { createPostageStampsStorageManager, type PostageStamp } from '@swarm-id/lib'
import { triggerSync } from '$lib/utils/sync-hooks'
import { sessionStore } from './session.svelte'

// ============================================================================
// Storage Manager
// ============================================================================

const storageManager = createPostageStampsStorageManager()

function loadPostageStamps(): PostageStamp[] {
	if (!browser) return []
	return storageManager.load()
}

function savePostageStamps(data: PostageStamp[]): void {
	storageManager.save(data)

	// Trigger Swarm sync
	const currentIdentityId = sessionStore.data.currentIdentityId
	if (currentIdentityId) {
		triggerSync(currentIdentityId)
	}
}

// ============================================================================
// Reactive Store
// ============================================================================

let postageStamps = $state<PostageStamp[]>(loadPostageStamps())

export const postageStampsStore = {
	get stamps() {
		return postageStamps
	},

	addStamp(stamp: Omit<PostageStamp, 'createdAt'>): PostageStamp {
		const newStamp: PostageStamp = {
			...stamp,
			createdAt: Date.now(),
		}
		postageStamps = [...postageStamps, newStamp]
		savePostageStamps(postageStamps)
		return newStamp
	},

	removeStamp(batchID: BatchId) {
		postageStamps = postageStamps.filter((s) => !s.batchID.equals(batchID))
		savePostageStamps(postageStamps)
	},

	getStamp(batchID: BatchId): PostageStamp | undefined {
		return postageStamps.find((s) => s.batchID.equals(batchID))
	},

	getStampsByIdentity(identityId: string): PostageStamp[] {
		return postageStamps.filter((s) => s.identityId === identityId)
	},

	clear() {
		postageStamps = []
		storageManager.clear()
	},
}

import { browser } from '$app/environment'
import { BatchId, EthAddress } from '@ethersphere/bee-js'
import { createPostageStampsStorageManager, type PostageStamp } from '@swarm-id/lib'
import { UtilizationAwareStamper } from '@swarm-id/lib/utils/batch-utilization'
import { UtilizationCacheDB } from '@swarm-id/lib/storage/utilization-cache'
import { triggerSync } from '$lib/utils/sync-hooks'

// ============================================================================
// Storage Manager
// ============================================================================

const storageManager = createPostageStampsStorageManager()

// Lazy utilization cache initialization (browser only)
let utilizationCache: UtilizationCacheDB | undefined

const getUtilizationCache = () => {
	if (!browser) {
		throw new Error('Utilization cache not available (browser only)')
	}

	if (!utilizationCache) {
		utilizationCache = new UtilizationCacheDB()
	}

	return utilizationCache
}

function loadPostageStamps(): PostageStamp[] {
	if (!browser) return []
	return storageManager.load()
}

function savePostageStamps(data: PostageStamp[], skipSync = false, accountId?: string): void {
	storageManager.save(data)

	// Trigger Swarm sync (unless explicitly skipped)
	if (!skipSync && accountId) {
		triggerSync(accountId)
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
		// Check for duplicate batch ID
		const existingStamp = postageStamps.find((s) => s.batchID.equals(stamp.batchID))
		if (existingStamp) {
			throw new Error(`Postage stamp with batch ID ${stamp.batchID.toHex()} already exists`)
		}

		const newStamp: PostageStamp = {
			...stamp,
			createdAt: Date.now(),
		}
		postageStamps = [...postageStamps, newStamp]
		savePostageStamps(postageStamps, false, stamp.accountId)
		return newStamp
	},

	removeStamp(batchID: BatchId, accountId: string) {
		postageStamps = postageStamps.filter((s) => !s.batchID.equals(batchID))
		savePostageStamps(postageStamps, false, accountId)
	},

	getStamp(batchID: BatchId): PostageStamp | undefined {
		return postageStamps.find((s) => s.batchID.equals(batchID))
	},

	getStampsByAccount(accountId: string): PostageStamp[] {
		return postageStamps.filter((s) => s.accountId === accountId)
	},

	async getStamper(
		batchID: BatchId,
		options?: { owner?: EthAddress; encryptionKey?: Uint8Array },
	): Promise<UtilizationAwareStamper | undefined> {
		const stamp = this.getStamp(batchID)
		if (!stamp) {
			return undefined
		}

		// Get utilization cache
		const cache = getUtilizationCache()

		// Create utilization-aware stamper with loaded bucket state
		const stamper = await UtilizationAwareStamper.create(
			stamp.signerKey.toUint8Array(),
			stamp.batchID,
			stamp.depth,
			cache,
			options,
		)

		return stamper
	},

	updateStampUtilization(batchID: BatchId, newUtilization: number) {
		const stamp = postageStamps.find((s) => s.batchID.equals(batchID))
		if (!stamp) {
			console.warn('[PostageStamps] Cannot update utilization: stamp not found')
			return
		}

		// Update utilization
		stamp.utilization = newUtilization

		// Save without triggering sync (to avoid infinite loop)
		savePostageStamps(postageStamps, true)

		console.log(`[PostageStamps] Updated utilization for ${batchID.toHex()}: ${newUtilization}%`)
	},

	clear() {
		postageStamps = []
		storageManager.clear()
	},
}

import {
	StateSyncManager,
	deriveIdentityBackupKey,
	deriveIdentityEncryptionKey,
	type IdentityStateSnapshot,
} from '@swarm-id/lib/sync'
import { identitiesStore } from './identities.svelte'
import { connectedAppsStore } from './connected-apps.svelte'
import { postageStampsStore } from './postage-stamps.svelte'
import { sessionStore } from './session.svelte'
import { Bee, PrivateKey } from '@ethersphere/bee-js'
import { browser } from '$app/environment'

// Reactive state
const syncEnabled = $state(true) // Auto-enabled for v1
const lastSyncTimes = $state<Map<string, number>>(new Map())

// Initialize Bee client (browser only)
const getBeeClient = () => {
	if (!browser) return undefined
	const beeApiUrl = window.__BEE_API_URL__ || 'http://localhost:1633'
	return new Bee(beeApiUrl)
}

const bee = getBeeClient()

// Lazy sync manager initialization
let syncManager: StateSyncManager | undefined

const getSyncManager = () => {
	if (!browser || !bee) {
		throw new Error('Sync manager not available (browser only)')
	}

	if (!syncManager) {
		syncManager = new StateSyncManager({
			bee,
			getIdentityKey: async (identityId: string) => {
				// Derive identity signing key from master key in session
				const masterKey = sessionStore.data.temporaryMasterKey
				if (!masterKey) {
					throw new Error('No master key in session')
				}

				const backupKeyHex = await deriveIdentityBackupKey(masterKey.toHex(), identityId)

				return new PrivateKey(backupKeyHex)
			},
		})
	}

	return syncManager
}

export const syncStore = {
	get enabled() {
		return syncEnabled
	},
	get lastSyncTimes() {
		return lastSyncTimes
	},

	/**
	 * Trigger sync for an identity
	 * Called by store hooks when state changes
	 */
	async syncIdentity(identityId: string): Promise<void> {
		if (!syncEnabled) return

		// Skip if not in browser
		if (!browser) {
			console.warn('[StateSync] Sync disabled - not in browser')
			return
		}

		// Get identity
		const identity = identitiesStore.getIdentity(identityId)
		if (!identity) return

		// Check for default postage stamp
		if (!identity.defaultPostageStampBatchID) {
			console.warn('[StateSync] No default stamp for identity', identityId)
			return
		}

		// Get master key from session
		const masterKey = sessionStore.data.temporaryMasterKey
		if (!masterKey) {
			console.warn('[StateSync] No master key in session')
			return
		}

		// Derive encryption key for this identity
		const encryptionKey = await deriveIdentityEncryptionKey(masterKey.toHex(), identityId)

		// Collect state snapshot
		const state: IdentityStateSnapshot = {
			version: 1,
			timestamp: Date.now(),
			identity,
			connectedApps: connectedAppsStore.getAppsByIdentityId(identityId),
			postageStamps: postageStampsStore.getStampsByIdentity(identityId),
		}

		// Get sync manager (lazy init)
		const manager = getSyncManager()

		// Sync to Swarm with encryption
		const result = await manager.syncIdentity(
			identityId,
			state,
			identity.defaultPostageStampBatchID,
			encryptionKey,
		)

		if (result.status === 'success') {
			lastSyncTimes.set(identityId, Date.now())
		} else {
			console.error('[StateSync] Sync failed:', result.error)
		}
	},
}

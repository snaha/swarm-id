import { StateSyncManager, type AccountStateSnapshot } from '@swarm-id/lib/sync'
import { deriveSecret } from '@swarm-id/lib'
import { identitiesStore } from './identities.svelte'
import { connectedAppsStore } from './connected-apps.svelte'
import { postageStampsStore } from './postage-stamps.svelte'
import { accountsStore } from './accounts.svelte'
import { networkSettingsStore } from './network-settings.svelte'
import { Bee, PrivateKey, BatchId, EthAddress, type Chunk } from '@ethersphere/bee-js'
import { browser } from '$app/environment'
import {
	updateAfterWrite,
	saveUtilizationState,
	calculateUtilizationPercentage,
} from '@swarm-id/lib/utils/batch-utilization'
import { UtilizationCacheDB } from '@swarm-id/lib/storage/utilization-cache'
import { DebouncedUtilizationUploader } from '@swarm-id/lib/storage/debounced-uploader'
import { hexToUint8Array } from '@swarm-id/lib/utils/hex'
import { SvelteDate } from 'svelte/reactivity'

// Reactive state
const syncEnabled = $state(true) // Auto-enabled for v1
const lastSyncTimes = $state<Map<string, number>>(new Map())

// Initialize Bee client (browser only)
const getBeeClient = () => {
	if (!browser) return undefined
	const beeApiUrl = networkSettingsStore.beeNodeUrl
	console.log(`[StateSync] Creating Bee client with URL: ${beeApiUrl}`)
	return new Bee(beeApiUrl)
}

const bee = getBeeClient()
if (bee) {
	console.log(`[StateSync] Bee client initialized with URL: ${bee.url}`)
}

/**
 * Convert chunk addresses to Chunk objects for utilization tracking
 *
 * Creates minimal chunk objects with just the address property
 * needed for bucket calculation. We don't need actual chunk data
 * since we're only tracking which buckets/slots were used.
 */
function createChunksFromAddresses(addresses: Uint8Array[]): Chunk[] {
	return addresses.map((address) => {
		// Create a minimal chunk object with the correct address
		// The utilization library only needs chunk.address.toUint8Array()
		return {
			address: {
				toUint8Array: () => address,
				toHex: () =>
					Array.from(address)
						.map((b) => b.toString(16).padStart(2, '0'))
						.join(''),
			},
			data: new Uint8Array(0), // Not used for utilization tracking
		} as Chunk
	})
}

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

// Debounced uploader for batch utilization (browser only)
let utilizationUploader: DebouncedUtilizationUploader | undefined

const getUtilizationUploader = () => {
	if (!browser) {
		throw new Error('Utilization uploader not available (browser only)')
	}

	if (!utilizationUploader) {
		utilizationUploader = new DebouncedUtilizationUploader() // Use default 1s delay
	}

	return utilizationUploader
}

// Lazy sync manager initialization
let syncManager: StateSyncManager | undefined

const getSyncManager = () => {
	if (!browser || !bee) {
		throw new Error('Sync manager not available (browser only)')
	}

	if (!syncManager) {
		syncManager = new StateSyncManager({
			bee,
			getAccountKey: async (accountId: string) => {
				// Derive account signing key from swarmEncryptionKey
				const account = accountsStore.getAccount(new EthAddress(accountId))
				if (!account) {
					throw new Error('Account not found')
				}

				const backupKeyHex = await deriveSecret(account.swarmEncryptionKey, 'backup-key')

				return new PrivateKey(backupKeyHex)
			},

			// Provide stamper factory with utilization tracking
			getStamper: async (postageStamp) => {
				// Get account for this stamp
				const account = accountsStore.getAccount(new EthAddress(postageStamp.accountId))
				if (!account) {
					throw new Error('Account not found for stamper creation')
				}

				// Derive owner address from backup key
				const backupKeyHex = await deriveSecret(account.swarmEncryptionKey, 'backup-key')
				const backupKey = new PrivateKey(backupKeyHex)
				const owner = backupKey.publicKey().address()

				// Get utilization-aware stamper from store
				const stamper = await postageStampsStore.getStamper(postageStamp.batchID, {
					owner,
					encryptionKey: hexToUint8Array(account.swarmEncryptionKey),
				})

				if (!stamper) {
					throw new Error(`Cannot create stamper for batch ${postageStamp.batchID.toHex()}`)
				}

				return stamper
			},

			// NEW: Provide utilization callbacks for browser-only utilization tracking
			utilization: {
				async onUtilizationUpdate(accountId: string, chunkAddresses: Uint8Array[]) {
					// This callback is called AFTER chunk upload, BEFORE feed update
					// Calculate utilization and upload it to Swarm

					if (!bee) {
						throw new Error('Bee client not available')
					}

					// Get account
					const account = accountsStore.getAccount(new EthAddress(accountId))
					if (!account) {
						console.warn('[StateSync] Account not found for utilization update')
						return
					}

					// Resolve default stamp
					const defaultStamp =
						account.defaultPostageStampBatchID ??
						identitiesStore.getIdentitiesByAccount(account.id)[0]?.defaultPostageStampBatchID

					if (!defaultStamp) {
						console.warn('[StateSync] No default stamp, skipping utilization')
						return
					}

					const batchID = new BatchId(defaultStamp)
					const stamp = postageStampsStore.getStamp(batchID)

					if (!stamp) {
						console.warn('[StateSync] Stamp not found, skipping utilization')
						return
					}

					// Convert chunk addresses to Chunks
					const chunks = createChunksFromAddresses(chunkAddresses)
					console.log(
						`[StateSync] Tracking ${chunks.length} chunks for utilization, batch depth: ${stamp.depth}`,
					)

					// Get cache and uploader
					const cache = getUtilizationCache()
					const uploader = getUtilizationUploader()

					// Derive owner address from backup key
					const backupKeyHex = await deriveSecret(account.swarmEncryptionKey, 'backup-key')
					const backupKey = new PrivateKey(backupKeyHex)
					const owner = backupKey.publicKey().address()

					// Update utilization state
					const { state: utilizationState, tracker } = await updateAfterWrite(
						batchID,
						chunks,
						stamp.depth,
						{
							bee,
							owner,
							encryptionKey: hexToUint8Array(account.swarmEncryptionKey),
							cache,
						},
					)

					// Calculate new utilization percentage
					const newUtilization = calculateUtilizationPercentage(utilizationState, stamp.depth)
					console.log(`[StateSync] New utilization: ${newUtilization.toFixed(2)}%`)

					// Update stamp in store (without triggering sync)
					postageStampsStore.updateStampUtilization(batchID, newUtilization)

					// Schedule debounced upload of dirty chunks and WAIT for it
					if (tracker.hasDirtyChunks()) {
						console.log(
							`[StateSync] Scheduling upload of ${tracker.getDirtyChunks().length} dirty chunks`,
						)

						// Get stamper for signing chunks (with loaded bucket state)
						const stamper = await postageStampsStore.getStamper(batchID, {
							owner,
							encryptionKey: hexToUint8Array(account.swarmEncryptionKey),
						})
						if (!stamper) {
							console.warn('[StateSync] Cannot create stamper, skipping upload')
							return
						}

						const uploadPromise = uploader.scheduleUpload(batchID.toHex(), tracker, async () => {
							await saveUtilizationState(utilizationState, {
								bee,
								stamper,
								encryptionKey: hexToUint8Array(account.swarmEncryptionKey),
								cache,
								tracker,
							})

							// Flush stamper bucket state updates to cache
							await stamper.flush()
						})

						// Add 30s timeout to prevent hanging
						const timeoutPromise = new Promise<void>((_, reject) => {
							setTimeout(() => reject(new Error('Utilization upload timeout (30s)')), 30000)
						})

						return Promise.race([uploadPromise, timeoutPromise])
					}
				},

				async getUtilizationPercentage(accountId: string) {
					const account = accountsStore.getAccount(new EthAddress(accountId))
					if (!account) return 0

					const defaultStamp =
						account.defaultPostageStampBatchID ??
						identitiesStore.getIdentitiesByAccount(account.id)[0]?.defaultPostageStampBatchID

					if (!defaultStamp) return 0

					const stamp = postageStampsStore.getStamp(new BatchId(defaultStamp))
					return stamp?.utilization ?? 0
				},
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
	 * Trigger sync for an account
	 * Called by store hooks when state changes
	 */
	async syncAccount(accountId: string): Promise<void> {
		const startTime = performance.now()
		console.log(
			`[StateSync ${new SvelteDate().toISOString()}] Starting sync for account ${accountId}`,
		)

		if (!syncEnabled) return

		// Skip if not in browser
		if (!browser) {
			console.warn('[StateSync] Sync disabled - not in browser')
			return
		}

		// Get account
		const account = accountsStore.getAccount(new EthAddress(accountId))
		if (!account) {
			console.warn('[StateSync] Account not found', accountId)
			return
		}
		console.log(
			`[StateSync ${new SvelteDate().toISOString()}] Account retrieved (+${(performance.now() - startTime).toFixed(2)}ms)`,
		)

		// Resolve default stamp (account or first identity)
		const defaultStampBatchID =
			account.defaultPostageStampBatchID ??
			identitiesStore.getIdentitiesByAccount(account.id)[0]?.defaultPostageStampBatchID

		if (!defaultStampBatchID) {
			console.warn('[StateSync] No default stamp for account', accountId)
			return
		}

		const defaultStamp = postageStampsStore.getStamp(defaultStampBatchID)
		if (!defaultStamp) {
			console.warn('[StateSync] No default stamp', defaultStampBatchID)
			return
		}

		// Get swarmEncryptionKey directly from account (already a hex string!)
		// Field is required in schema, so it will always be present for valid accounts
		const encryptionKey = account.swarmEncryptionKey
		console.log(
			`[StateSync ${new SvelteDate().toISOString()}] Encryption key retrieved (+${(performance.now() - startTime).toFixed(2)}ms)`,
		)

		// Collect account state
		const identities = identitiesStore.getIdentitiesByAccount(account.id)
		const apps = identities.flatMap((identity) =>
			connectedAppsStore.getAppsByIdentityId(identity.id),
		)
		const stamps = postageStampsStore.getStampsByAccount(accountId)
		console.log(
			`[StateSync ${new SvelteDate().toISOString()}] State collected: ${identities.length} identities, ${apps.length} apps, ${stamps.length} stamps (+${(performance.now() - startTime).toFixed(2)}ms)`,
		)

		const state: AccountStateSnapshot = {
			version: 1,
			timestamp: SvelteDate.now(),
			accountId,
			metadata: {
				defaultPostageStampBatchID: defaultStampBatchID.toHex(),
				createdAt: account.createdAt,
				lastModified: SvelteDate.now(),
			},
			identities,
			connectedApps: apps,
			postageStamps: stamps,
		}

		// Get sync manager (lazy init)
		const manager = getSyncManager()
		console.log(
			`[StateSync ${new SvelteDate().toISOString()}] Sync manager ready (+${(performance.now() - startTime).toFixed(2)}ms)`,
		)

		// Sync to Swarm with encryption
		console.log(
			`[StateSync ${new SvelteDate().toISOString()}] Starting upload to Swarm... (+${(performance.now() - startTime).toFixed(2)}ms)`,
		)
		const result = await manager.syncAccount(accountId, state, defaultStamp, encryptionKey)
		console.log(
			`[StateSync ${new SvelteDate().toISOString()}] Upload completed (+${(performance.now() - startTime).toFixed(2)}ms)`,
		)

		if (result.status === 'success') {
			console.log(
				`[StateSync ${new SvelteDate().toISOString()}] ✅ Sync completed: ${result.reference}`,
			)
			console.log(
				`[StateSync ${new SvelteDate().toISOString()}] ✅ TOTAL SYNC TIME: ${(performance.now() - startTime).toFixed(2)}ms`,
			)
			lastSyncTimes.set(accountId, SvelteDate.now())
		} else {
			console.error(
				`[StateSync ${new SvelteDate().toISOString()}] Sync failed (+${(performance.now() - startTime).toFixed(2)}ms):`,
				result.error,
			)
		}
	},
}

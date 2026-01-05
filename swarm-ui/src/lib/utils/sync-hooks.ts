import { syncStore } from '../stores/sync.svelte'

// Debounce timer per identity
const syncTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Trigger sync for an identity with debouncing
 *
 * Multiple rapid changes are batched into a single sync
 */
export function triggerSync(identityId: string): void {
	// Clear existing timer
	const existingTimer = syncTimers.get(identityId)
	if (existingTimer) {
		clearTimeout(existingTimer)
	}

	// Set new timer (2 second debounce)
	const timer = setTimeout(() => {
		syncStore.syncIdentity(identityId)
		syncTimers.delete(identityId)
	}, 2000)

	syncTimers.set(identityId, timer)
}

import { syncStore } from '../stores/sync.svelte'

// Debounce timer per account
const syncTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Trigger sync for an account with debouncing
 *
 * Multiple rapid changes are batched into a single sync
 */
export function triggerSync(accountId: string): void {
  // Clear existing timer
  const existingTimer = syncTimers.get(accountId)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  // Set new timer (2 second debounce)
  const timer = setTimeout(() => {
    syncStore.syncAccount(accountId)
    syncTimers.delete(accountId)
  }, 2000)

  syncTimers.set(accountId, timer)
}

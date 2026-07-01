// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { syncStore } from '$lib/dev/sync.svelte'

// How long to coalesce rapid account mutations before publishing once.
const SYNC_DEBOUNCE_MS = 2000

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

  // Set new timer (2 second debounce). The publish is fire-and-forget, so guard
  // the promise: an unhandled rejection here would surface as a console error
  // (or crash strict environments) rather than a silent failed sync.
  const timer = setTimeout(() => {
    syncTimers.delete(accountId)
    void syncStore.syncAccount(accountId).catch((err) => {
      console.error(`[sync] account ${accountId} failed:`, err)
    })
  }, SYNC_DEBOUNCE_MS)

  syncTimers.set(accountId, timer)
}

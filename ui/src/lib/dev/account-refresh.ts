// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Background fold-back for the signed-in account: pull peer/node state from Swarm
 * into the local account (name, connected apps, stamps, and node truth like a
 * batch's real utilization / TTL). The publish direction is wired app-wide in the
 * root layout; this is the read direction.
 *
 * Only ONE tab actually fetches per window — `runCoalescedAcrossTabs` (Web Lock +
 * shared cooldown timestamp) collapses concurrent folds across tabs, and the
 * winner's persisted account document propagates to the others via the accounts
 * store's `storage` listener. Folds apply with `skipSync: true`, so they never
 * re-publish.
 */
import { runCoalescedAcrossTabs } from '@snaha/swarm-id'

import { browser } from '$app/environment'

import { refreshAccountFromSwarm } from '$lib/dev/refresh-account-from-swarm'
import { sessionStore } from '$lib/stores/session.svelte'

// "Every few minutes" — the cross-tab window doubles as the interval, so with N
// tabs open only ~one fold runs per window.
const FOLD_INTERVAL_MS = 3 * 60 * 1000
const FOLD_LOCK_NAME = 'swarm-id-account-fold'
const FOLD_COOLDOWN_KEY_PREFIX = 'swarm-id-account-folded-at-'

// Per-tab guard so overlapping triggers (interval + account switch) don't stack.
let inFlight = false

/**
 * Fold the currently-active account. `force` bypasses the cross-tab cooldown
 * (page load / account switch); the periodic tick passes `false` so it coalesces.
 */
export async function foldCurrentAccount(force: boolean): Promise<void> {
  const accountId = sessionStore.currentAccountId
  if (!accountId || inFlight) {
    return
  }
  inFlight = true
  try {
    await runCoalescedAcrossTabs({
      lockName: FOLD_LOCK_NAME,
      cooldownKey: `${FOLD_COOLDOWN_KEY_PREFIX}${accountId}`,
      cooldownMs: FOLD_INTERVAL_MS,
      force,
      task: async () => {
        const result = await refreshAccountFromSwarm(accountId)
        if (!result.ok && result.kind === 'error') {
          console.warn(`[account-fold] ${accountId} failed:`, result.error)
        }
      },
    })
  } finally {
    inFlight = false
  }
}

/** Start the periodic (coalesced) fold. Returns a teardown. */
export function startFoldInterval(): () => void {
  if (!browser) {
    return () => undefined
  }
  const timer = setInterval(() => void foldCurrentAccount(false), FOLD_INTERVAL_MS)
  return () => clearInterval(timer)
}

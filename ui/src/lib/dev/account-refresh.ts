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
// Short window honoured even under `force`, so a burst of forced folds collapses:
// N restored tabs each forcing on load, and the post-sign-in fold immediately
// after the import page's own fold (which stamps via `noteAccountFolded`).
const FOLD_GRACE_MS = 5 * 1000
const FOLD_LOCK_NAME = 'swarm-id-account-fold'
const FOLD_COOLDOWN_KEY_PREFIX = 'swarm-id-account-folded-at-'

const foldCooldownKey = (accountId: string) => `${FOLD_COOLDOWN_KEY_PREFIX}${accountId}`

// Per-tab, per-account guard so overlapping triggers (interval + account switch)
// don't stack — keyed so an A→B switch while A's fold runs still folds B.
const inFlight = new Set<string>()

/**
 * Fold the currently-active account. `force` bypasses the cross-tab cooldown
 * (page load / account switch); the periodic tick passes `false` so it coalesces.
 */
export async function foldCurrentAccount(force: boolean): Promise<void> {
  const accountId = sessionStore.currentAccountId
  if (!accountId || inFlight.has(accountId)) {
    return
  }
  inFlight.add(accountId)
  try {
    await runCoalescedAcrossTabs({
      lockName: FOLD_LOCK_NAME,
      cooldownKey: foldCooldownKey(accountId),
      cooldownMs: FOLD_INTERVAL_MS,
      graceMs: FOLD_GRACE_MS,
      force,
      task: async () => {
        const result = await refreshAccountFromSwarm(accountId)
        if (!result.ok && result.kind === 'error') {
          console.warn(`[account-fold] ${accountId} failed:`, result.error)
        }
      },
    })
  } finally {
    inFlight.delete(accountId)
  }
}

/**
 * Stamp the fold cooldown for `accountId` as "just folded". The import/sign-in
 * flow folds directly (not via `foldCurrentAccount`); calling this after it lets
 * the forced fold triggered right after finalize skip within the grace window
 * instead of re-folding back-to-back.
 */
export function noteAccountFolded(accountId: string): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  localStorage.setItem(foldCooldownKey(accountId), String(Date.now()))
}

/** Start the periodic (coalesced) fold. Returns a teardown. */
export function startFoldInterval(): () => void {
  if (!browser) {
    return () => undefined
  }
  const timer = setInterval(() => void foldCurrentAccount(false), FOLD_INTERVAL_MS)
  return () => clearInterval(timer)
}

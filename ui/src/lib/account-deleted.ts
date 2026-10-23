// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The two ends of the account deletion marker away from the deleting device:
 * a peer forgetting an account that was deleted elsewhere, and a restore
 * bringing a deleted account back (docs/Account-State.md, the scalars).
 *
 * Both folds — a peer's bus delta and the Swarm refresh — land the marker
 * through `applyRefreshed`, which reports when it is the fold that deleted the
 * account; the deleting device already holds the marker, so it never takes
 * this path for its own deletion.
 */
import type { SyncedAccount } from '@snaha/swarm-id/internal'

import { accountsStore } from '$lib/stores/accounts.svelte'
import { sessionStore } from '$lib/stores/session.svelte'
import { toastStore } from '$lib/stores/toast.svelte'
import type { Account } from '$lib/types'

export const DELETED_ELSEWHERE_MESSAGE = 'This account was deleted on another device'

/** Drop an account another device deleted, leaving the session if it was it. */
export function forgetAccountDeletedElsewhere(account: Account): void {
  accountsStore.remove(account.id)
  if (sessionStore.currentAccountId === account.id.toHex()) {
    sessionStore.clearCurrentAccount()
  }
  toastStore.show(DELETED_ELSEWHERE_MESSAGE)
}

/**
 * A restored record, claimed back: not deleted, on a fresh clock.
 *
 * Every restore states it — recovery phrase or sign-back-in — not only one
 * that folded a deletion. Unlocking the account is the user saying they want
 * it, and a sign-back-in from the local snapshot cannot see a deletion made
 * elsewhere while it was signed out; without the claim the next fold would
 * remove the account the user just signed back into. Drives kept at deletion
 * come back with it.
 */
export function reclaimed<T extends Pick<SyncedAccount, 'deleted' | 'deletedAt'>>(record: T): T {
  return { ...record, deleted: false, deletedAt: Date.now() }
}

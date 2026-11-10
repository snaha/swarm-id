// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The deletion marker away from the deleting device: a peer forgetting the
 * account, and a restore claiming it back (docs/Account-State.md, "Account
 * deletion").
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
 * A restored record, claimed back: not deleted, on a fresh clock. Every
 * restore claims it, since a sign-back-in from the local snapshot cannot see a
 * deletion made while it was signed out.
 */
export function reclaimed<T extends Pick<SyncedAccount, 'deleted' | 'deletedAt'>>(record: T): T {
  return { ...record, deleted: false, deletedAt: Date.now() }
}

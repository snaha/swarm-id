// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run `op` under an exclusive, cross-tab Web Lock keyed on the ACCOUNT.
 *
 * All stamped writers for a given account — every same-origin context: dApp
 * proxy iframes and the SwarmID UI's background sync — request the same lock
 * name, so only one write runs at a time across tabs. The lock is
 * account-scoped (not batch-scoped) because the partition lease it guards is:
 * the partition claim's lock/intent/occupancy SOCs derive from the account
 * backup signer alone, so writers to DIFFERENT batches of one account still
 * mutate the same lease and must exclude each other. This is the single
 * definition of the `swarm-write-account-<accountId>` convention.
 *
 * Falls back to running `op` directly when the Web Locks API is unavailable
 * (Node / test environments).
 */
export function withAccountWriteLock<T>(
  accountId: string | undefined,
  op: () => Promise<T>,
): Promise<T> {
  const lockName = `swarm-write-account-${accountId?.toLowerCase()}`
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(lockName, { mode: "exclusive" }, op)
  }
  return op()
}

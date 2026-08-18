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
 * `legacyBatchIdsHex` — TRANSITION GUARD. Pre-account-scoped versions keyed
 * this lock `swarm-write-<batchId>` (the old `withBatchWriteLock`), so during
 * a deploy rollover an old tab still writes under that key and the account
 * lock alone would not exclude it. Callers pass the batch ids this locked
 * section may stamp under and the legacy per-batch locks are acquired NESTED
 * inside the account lock. Deadlock-free by construction: every new-version
 * writer serializes on the account lock BEFORE requesting any legacy lock,
 * and old-version writers only ever hold a single legacy lock. Remove once no
 * pre-account-scoped clients remain in the wild.
 *
 * Falls back to running `op` directly when the Web Locks API is unavailable
 * (Node / test environments).
 */
export function withAccountWriteLock<T>(
  accountId: string,
  op: () => Promise<T>,
  legacyBatchIdsHex: string[] = [],
): Promise<T> {
  if (!accountId) {
    // Interpolating a missing id would silently share one global
    // "swarm-write-account-undefined" lock across every account.
    return Promise.reject(
      new Error("withAccountWriteLock: accountId is required"),
    )
  }
  if (typeof navigator === "undefined" || !navigator.locks) {
    return op()
  }
  // Sorted + deduped so concurrent callers nest the legacy locks in one
  // deterministic order.
  const legacy = [...new Set(legacyBatchIdsHex)].sort()
  const nested = legacy.reduceRight<() => Promise<T>>(
    (inner, batchIdHex) => () =>
      navigator.locks.request(
        `swarm-write-${batchIdHex}`,
        { mode: "exclusive" },
        inner,
      ),
    op,
  )
  return navigator.locks.request(
    `swarm-write-account-${accountId.toLowerCase()}`,
    { mode: "exclusive" },
    nested,
  )
}

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
 * `batchStateIdsHex` — the batch ids this locked section may stamp under.
 * Their `swarm-write-<batchId>` locks are acquired NESTED inside the account
 * lock. This nesting is a PERMANENT invariant, not just the historical
 * rollover guard it started as (pre-account-scoped versions keyed their whole
 * write lock `swarm-write-<batchId>`): the per-batch lock is what guards a
 * batch's STAMPER BUCKET STATE — `withBatchStateLock` orders a stamper's
 * IndexedDB seed read against a same-batch write's flush without making it
 * wait for unrelated batches' writes. Deadlock-free by construction: writers
 * always acquire account → batch (one fixed order), and stamper builds acquire
 * a single batch lock only.
 *
 * Falls back to running `op` directly when the Web Locks API is unavailable
 * (Node / test environments).
 */
export function withAccountWriteLock<T>(
  accountId: string,
  op: () => Promise<T>,
  batchStateIdsHex: string[] = [],
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
  // Sorted + deduped so concurrent callers nest the per-batch locks in one
  // deterministic order.
  const batches = [...new Set(batchStateIdsHex)].sort()
  const nested = batches.reduceRight<() => Promise<T>>(
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

/**
 * Run `op` under one batch's exclusive, cross-tab `swarm-write-<batchId>` Web
 * Lock — the lock that guards that batch's STAMPER BUCKET STATE. Every stamped
 * write nests this lock inside the account lock (see `withAccountWriteLock`)
 * for each batch it may stamp under, holding it across the write AND its
 * bucket-state flush; taking it alone therefore orders a stamper's IndexedDB
 * seed read against any same-batch write's flush WITHOUT waiting on the
 * account lock — which an unrelated batch's minutes-long upload may hold.
 * Deadlock-free: writers acquire account → batch in one fixed order, and this
 * helper acquires a single batch lock only, never the account lock.
 *
 * Falls back to running `op` directly when the Web Locks API is unavailable
 * (Node / test environments).
 */
export function withBatchStateLock<T>(
  batchIdHex: string,
  op: () => Promise<T>,
): Promise<T> {
  if (!batchIdHex) {
    // Interpolating a missing id would silently share one global
    // "swarm-write-undefined" lock across every batch.
    return Promise.reject(new Error("withBatchStateLock: batchId is required"))
  }
  if (typeof navigator === "undefined" || !navigator.locks) {
    return op()
  }
  return navigator.locks.request(
    `swarm-write-${batchIdHex}`,
    { mode: "exclusive" },
    op,
  )
}

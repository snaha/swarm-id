// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run `op` under an exclusive, cross-tab Web Lock keyed on the postage batch.
 *
 * All writers to a given batch — every same-origin context: dApp proxy iframes
 * and the SwarmID UI — request the same lock name, so only one write runs at a
 * time across tabs. This is the single definition of the `swarm-write-<batchId>`
 * convention (the proxy and the account-sync path both use it).
 *
 * Falls back to running `op` directly when the Web Locks API is unavailable
 * (Node / test environments).
 */
export function withBatchWriteLock<T>(
  batchIdHex: string | undefined,
  op: () => Promise<T>,
): Promise<T> {
  const lockName = `swarm-write-${batchIdHex}`
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(lockName, { mode: "exclusive" }, op)
  }
  return op()
}

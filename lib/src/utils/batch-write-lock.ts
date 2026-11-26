// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { abortedError } from "../errors"

/**
 * Run `op` under an exclusive, cross-tab Web Lock keyed on the postage batch.
 *
 * All writers to a given batch — every same-origin context: dApp proxy iframes
 * and the SwarmID UI — request the same lock name, so only one write runs at a
 * time across tabs. This is the single definition of the `swarm-write-<batchId>`
 * convention (the proxy and the account-sync path both use it).
 *
 * `signal` ends the wait: a write aborted while it queues leaves the queue at
 * once and rejects with `aborted`, without running `op`.
 *
 * Falls back to running `op` directly when the Web Locks API is unavailable
 * (Node / test environments).
 */
export async function withBatchWriteLock<T>(
  batchIdHex: string | undefined,
  op: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw abortedError(signal)
  const lockName = `swarm-write-${batchIdHex}`
  if (typeof navigator !== "undefined" && navigator.locks) {
    try {
      return await navigator.locks.request(
        lockName,
        { mode: "exclusive", signal },
        op,
      )
    } catch (error) {
      // A request aborted while it queues rejects with the signal's reason, as
      // does an `op` that ends on the abort itself: either way the write was
      // aborted.
      if (signal?.aborted && error === signal.reason) {
        throw abortedError(signal)
      }
      throw error
    }
  }
  return op()
}

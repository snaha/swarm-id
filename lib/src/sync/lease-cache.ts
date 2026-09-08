// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The partition-lease cache: one localStorage record per (account, batch),
 * holding the claim this device last made on the batch's lock SOC.
 *
 * Two kinds of context write it. The proxy's persistent coordinator, for
 * reload restore (`adoptIfLive`). And every sibling context of the same device
 * that re-acquires the device's claim under a newer generation: a second tab
 * of the dApp, or the SwarmID tab's one-shot sync (`sync-account.ts`). The
 * store is shared by all of them whenever they share a device id at all
 * (a partitioned proxy keeps its own id in its own store), which is what lets
 * a page that is unloading tell, synchronously, whether a sibling still holds
 * the lease it is about to release (#676, `teardownOnUnload`).
 */

import type { PartitionLeaseStateSnapshot } from "./partition-lease"
import { compareGenerations } from "./partition-lock"
import { leaseCacheStorageKey } from "../types"

export function readLeaseCache(
  accountId: string,
  batchId: string,
): PartitionLeaseStateSnapshot | undefined {
  try {
    const raw = localStorage.getItem(leaseCacheStorageKey(accountId, batchId))
    return raw ? (JSON.parse(raw) as PartitionLeaseStateSnapshot) : undefined
  } catch {
    return undefined
  }
}

/**
 * `undefined` clears the record. A snapshot replaces it unless the record
 * holds a newer, still-live claim of the same device: that is a sibling that
 * re-acquired the lease, and its claim outranks ours exactly as it would on
 * the lock SOC (`releasePartitionLock` skips on "a newer own claim exists").
 * Keeping it is what makes `teardownOnUnload`'s read of this record answer
 * the same question the awaited release answers with a read of the SOC.
 */
export function writeLeaseCache(
  accountId: string,
  batchId: string,
  snap: PartitionLeaseStateSnapshot | undefined,
  now: () => number = Date.now,
): void {
  const key = leaseCacheStorageKey(accountId, batchId)
  if (!snap) {
    // ponytail: a clear is unconditional — the clearing context is going
    // away, and its successor re-reads the lock SOC on its next acquire.
    localStorage.removeItem(key)
    return
  }
  const cached = readLeaseCache(accountId, batchId)
  const live = cached?.self
  if (
    live &&
    cached.deviceId === snap.deviceId &&
    live.leasedUntil > now() &&
    (!snap.self ||
      compareGenerations(live.generation, snap.self.generation) > 0)
  ) {
    return
  }
  localStorage.setItem(key, JSON.stringify(snap))
}

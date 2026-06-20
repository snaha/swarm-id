// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Merge a locally-built account snapshot with the most recent on-Swarm
 * snapshot before publishing.
 *
 * Sync overwrites the feed entry on each write, so a naïve "publish local
 * state" stomps anything a peer just wrote. The fix is to fold the remote
 * snapshot into the local one and publish the union.
 *
 * Strategy per field:
 *
 * - `devices`: union by `deviceId`. On conflict prefer the entry with the
 *   larger `lastSignedInAt` (recent sign-ins win).
 * - `connectedApps`: last-writer-wins per `appUrl` (with `revokedAt` tombstone).
 * - `postageStamps`: union by `batchID`; local entries win on overlap.
 * - `metadata.accountName`, `metadata.defaultPostageStampBatchID`,
 *   `metadata.partitionCount`: local wins. These are scalar fields set
 *   by user actions.
 * - `metadata.createdAt`: keep local's (it's the account's birth date,
 *   should be identical anyway).
 * - `timestamp` / `metadata.lastModified`: refreshed to `Date.now()`.
 *
 * The function is pure and deterministic so it's easy to unit-test. The
 * per-collection primitives are exported so the read/refresh path can reuse the
 * exact same rules instead of redefining them.
 */

import type { AccountStateSnapshot } from "../utils/account-state-snapshot"
import type {
  Device,
  ConnectedApp,
  PostageStamp,
  AccountMetadata,
} from "../schemas"

export function mergeSnapshotWithRemote(
  local: AccountStateSnapshot,
  remote: AccountStateSnapshot | undefined,
): AccountStateSnapshot {
  if (!remote) return local

  const metadata: AccountMetadata = {
    ...local.metadata,
    lastModified: Date.now(),
    devices: mergeDevicesList(local.metadata.devices, remote.metadata.devices),
  }

  return {
    ...local,
    timestamp: Date.now(),
    metadata,
    connectedApps: mergeConnectedApps(
      local.connectedApps,
      remote.connectedApps,
    ),
    postageStamps: mergePostageStamps(
      local.postageStamps,
      remote.postageStamps,
    ),
  }
}

export function mergeDevicesList(local: Device[], remote: Device[]): Device[] {
  const merged = new Map<string, Device>()
  for (const d of remote) merged.set(d.deviceId, d)
  for (const d of local) {
    const existing = merged.get(d.deviceId)
    if (!existing) {
      merged.set(d.deviceId, d)
    } else {
      // Larger lastSignedInAt wins. If equal, local wins (more recent
      // observation here).
      const lAt = d.lastSignedInAt ?? 0
      const eAt = existing.lastSignedInAt ?? 0
      merged.set(d.deviceId, lAt >= eAt ? d : existing)
    }
  }
  return Array.from(merged.values())
}

export function mergeConnectedApps(
  local: ConnectedApp[],
  remote: ConnectedApp[],
): ConnectedApp[] {
  const keyOf = (a: ConnectedApp) => a.appUrl
  // Last-writer-wins per app so updates AND removals propagate: a revoke is a
  // tombstone (`revokedAt`) carrying a fresh `updatedAt`, so it supersedes an
  // older active copy. `updatedAt` falls back to `lastConnectedAt` for records
  // written before the field existed. Distinct apps still both survive (union).
  const recency = (a: ConnectedApp) => a.updatedAt ?? a.lastConnectedAt ?? 0
  const merged = new Map<string, ConnectedApp>()
  // Process remote first, then local, so a tie favours local (most recent
  // observation here); a strictly-newer entry on either side wins.
  for (const a of [...remote, ...local]) {
    const existing = merged.get(keyOf(a))
    if (!existing || recency(a) >= recency(existing)) merged.set(keyOf(a), a)
  }
  return Array.from(merged.values())
}

export function mergePostageStamps(
  local: PostageStamp[],
  remote: PostageStamp[],
): PostageStamp[] {
  const merged = new Map<string, PostageStamp>()
  for (const s of remote) merged.set(s.batchID.toHex(), s)
  for (const s of local) merged.set(s.batchID.toHex(), s) // local wins
  return Array.from(merged.values())
}

function listContainsAll<T>(
  latest: T[],
  mine: T[],
  key: (t: T) => string,
): boolean {
  const present = new Set(latest.map(key))
  return mine.every((item) => present.has(key(item)))
}

/**
 * True when `latest` already includes every device / connected-app /
 * postage-stamp present in `mine` (compared by their natural keys — the same
 * keys `mergeSnapshotWithRemote` unions on; timestamps and scalar metadata are
 * ignored).
 *
 * Used by the publish path to tell a *real* last-writer-wins loss (our entities
 * were dropped) apart from a harmless co-writer that published the same account
 * (e.g. the proxy announcing this device while the UI also syncs it) — whose
 * union still contains us, so convergence held and there is nothing to retry.
 *
 * Note: this is membership-only. Tombstone/scalar nuances (a revoke or an
 * account rename stomped by a co-writer) are NOT detected here; the union
 * merge's recency rules reconcile those on the next sync.
 */
export function snapshotContainsContribution(
  mine: AccountStateSnapshot,
  latest: AccountStateSnapshot,
): boolean {
  return (
    listContainsAll(
      latest.metadata.devices,
      mine.metadata.devices,
      (d) => d.deviceId,
    ) &&
    listContainsAll(
      latest.connectedApps,
      mine.connectedApps,
      (a) => a.appUrl,
    ) &&
    listContainsAll(latest.postageStamps, mine.postageStamps, (s) =>
      s.batchID.toHex(),
    )
  )
}

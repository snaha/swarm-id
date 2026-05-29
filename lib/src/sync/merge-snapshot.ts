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
 * - `identities` / `connectedApps` / `postageStamps`: union by their
 *   natural keys; local entries win on overlap (user actions on this
 *   device are most recent for those entities).
 * - `metadata.accountName`, `metadata.defaultPostageStampBatchID`,
 *   `metadata.partitionCount`: local wins. These are scalar fields set
 *   by user actions.
 * - `metadata.createdAt`: keep local's (it's the account's birth date,
 *   should be identical anyway).
 * - `timestamp` / `metadata.lastModified`: refreshed to `Date.now()`.
 *
 * The function is pure and deterministic so it's easy to unit-test.
 */

import type { AccountStateSnapshot } from "../utils/account-state-snapshot"
import type {
  Device,
  Identity,
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
    identities: mergeIdentities(local.identities, remote.identities),
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

function mergeDevicesList(local: Device[], remote: Device[]): Device[] {
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

function mergeIdentities(local: Identity[], remote: Identity[]): Identity[] {
  const merged = new Map<string, Identity>()
  for (const i of remote) merged.set(i.id, i)
  for (const i of local) merged.set(i.id, i) // local wins on collision
  return Array.from(merged.values())
}

function mergeConnectedApps(
  local: ConnectedApp[],
  remote: ConnectedApp[],
): ConnectedApp[] {
  const keyOf = (a: ConnectedApp) => `${a.identityId}:${a.appUrl}`
  const merged = new Map<string, ConnectedApp>()
  for (const a of remote) merged.set(keyOf(a), a)
  for (const a of local) merged.set(keyOf(a), a) // local wins
  return Array.from(merged.values())
}

function mergePostageStamps(
  local: PostageStamp[],
  remote: PostageStamp[],
): PostageStamp[] {
  const merged = new Map<string, PostageStamp>()
  for (const s of remote) merged.set(s.batchID.toHex(), s)
  for (const s of local) merged.set(s.batchID.toHex(), s) // local wins
  return Array.from(merged.values())
}

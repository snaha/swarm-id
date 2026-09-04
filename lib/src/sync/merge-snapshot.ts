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
 * - `devices`: last-writer-wins per `deviceId` with a `removedAt` tombstone.
 *   The recency clock is `max(removedAt, lastSignedInAt)`, so a removal beats an
 *   older sign-in and a newer sign-in re-activates a removed device. The name
 *   overlays on its own `nameUpdatedAt` clock, since a rename moves neither.
 * - `connectedApps`: last-writer-wins per `appUrl` (with `revokedAt` tombstone).
 * - `postageStamps`: last-writer-wins per `batchID` with a `deletedAt`
 *   tombstone (recency `max(deletedAt, createdAt)`), so deletions propagate and
 *   a fresh re-add (newer `createdAt`) re-activates a deleted stamp.
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
  // Last-writer-wins per device on TWO clocks, exactly as stamps merge below:
  //
  // - Membership (the whole record) merges on `max(removedAt, lastSignedInAt)`,
  //   so a removal beats an older sign-in and a newer sign-in beats an older
  //   removal (re-activating the device). With nothing removed this reduces to
  //   the old "larger lastSignedInAt wins". Removed devices are kept (the
  //   tombstone keeps propagating).
  // - The name overlays on its own `nameUpdatedAt` clock. A rename moves
  //   neither of the membership fields, so without this it tied with every
  //   stale copy of itself and lost — #643's correction never left the device
  //   that made it (#663). Riding its own clock also means it cannot drag a
  //   stale record's sign-in state along or resurrect a tombstone.
  const recency = (d: Device) =>
    Math.max(d.removedAt ?? 0, d.lastSignedInAt ?? 0)
  const nameRecency = (d: Device) => d.nameUpdatedAt ?? 0
  const merged = new Map<string, Device>()
  // Process remote first, then local, so a tie favours local (most recent
  // observation here); a strictly-newer entry on either side wins.
  for (const d of [...remote, ...local]) {
    const existing = merged.get(d.deviceId)
    if (!existing) {
      merged.set(d.deviceId, d)
      continue
    }
    const winner = recency(d) >= recency(existing) ? d : existing
    const loser = winner === d ? existing : d
    merged.set(
      d.deviceId,
      nameRecency(loser) > nameRecency(winner)
        ? { ...winner, name: loser.name, nameUpdatedAt: loser.nameUpdatedAt }
        : winner,
    )
  }
  return Array.from(merged.values())
}

export function mergeConnectedApps(
  local: ConnectedApp[],
  remote: ConnectedApp[],
): ConnectedApp[] {
  const keyOf = (a: ConnectedApp) => a.appUrl
  // Last-writer-wins per app on TWO clocks, the way devices and stamps merge:
  //
  // - Membership (the whole entry) merges on the fields that STATE membership,
  //   `max(revokedAt, disconnectedAt, lastConnectedAt)`. A removal beats an
  //   older connect, and a genuine reconnect — `connectApp` clears both markers
  //   and sets a fresh `lastConnectedAt` — beats an older removal. One clock
  //   bumped by every write ranked the entry instead, so a drive picked on a
  //   stale copy outranked a revoke and restored the credential it had cleared
  //   (#681).
  // - The stamp pointer overlays on its own `postageStampBatchIDAt`. It moves
  //   no membership field, so without a clock of its own it ties with every
  //   stale copy of the entry and loses — the same correction #663 made for a
  //   device's name.
  //
  // Distinct apps still both survive (union).
  const recency = (a: ConnectedApp) =>
    Math.max(a.revokedAt ?? 0, a.disconnectedAt ?? 0, a.lastConnectedAt ?? 0)
  const stampRecency = (a: ConnectedApp) => a.postageStampBatchIDAt ?? 0
  const merged = new Map<string, ConnectedApp>()
  // Process remote first, then local, so a tie favours local (most recent
  // observation here); a strictly-newer entry on either side wins.
  for (const a of [...remote, ...local]) {
    const existing = merged.get(keyOf(a))
    if (!existing) {
      merged.set(keyOf(a), a)
      continue
    }
    const winner = recency(a) >= recency(existing) ? a : existing
    const loser = winner === a ? existing : a
    merged.set(
      keyOf(a),
      stampRecency(loser) > stampRecency(winner)
        ? {
            ...winner,
            postageStampBatchID: loser.postageStampBatchID,
            postageStampBatchIDAt: loser.postageStampBatchIDAt,
          }
        : winner,
    )
  }
  return Array.from(merged.values())
}

export function mergePostageStamps(
  local: PostageStamp[],
  remote: PostageStamp[],
): PostageStamp[] {
  const keyOf = (s: PostageStamp) => s.batchID.toHex()
  // Last-writer-wins per batch so deletions AND edits propagate, on TWO clocks:
  //
  // - Node state (the whole record) merges on `max(deletedAt, updatedAt,
  //   createdAt)` — a delete beats an older add/edit, a dilute/top-up
  //   (`updatedAt`) beats a stale copy, and a fresh re-add (new `createdAt`)
  //   re-activates the stamp, matching device resurrection. Deleted stamps are
  //   kept (the tombstone keeps propagating until a re-add or newer node edit
  //   supersedes it).
  // - The name overlays on its own `nameUpdatedAt` clock. A rename made over a
  //   stale copy carries no node-state recency, so it can neither drag old
  //   depth/amount/batchTTL past a concurrent dilute/top-up nor resurrect a
  //   tombstone — but the newest name still wins.
  const recency = (s: PostageStamp) =>
    Math.max(s.deletedAt ?? 0, s.updatedAt ?? 0, s.createdAt)
  const nameRecency = (s: PostageStamp) => s.nameUpdatedAt ?? 0
  const merged = new Map<string, PostageStamp>()
  // Process remote first, then local, so a tie favours local (most recent
  // observation here); a strictly-newer entry on either side wins.
  for (const s of [...remote, ...local]) {
    const existing = merged.get(keyOf(s))
    if (!existing) {
      merged.set(keyOf(s), s)
      continue
    }
    const winner = recency(s) >= recency(existing) ? s : existing
    const loser = winner === s ? existing : s
    merged.set(
      keyOf(s),
      nameRecency(loser) > nameRecency(winner)
        ? { ...winner, name: loser.name, nameUpdatedAt: loser.nameUpdatedAt }
        : winner,
    )
  }
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

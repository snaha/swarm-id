// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ConnectionInfo } from "../types"

/**
 * Structural equality for {@link ConnectionInfo} snapshots, scoped to the
 * fields the proxy emits to dApps. Used by the proxy to suppress redundant
 * `connectionInfoChanged` events.
 *
 * `storagePartitioned` is compared via boolean coercion so a writer that
 * sends `false` and one that omits the field (effectively `undefined`)
 * are treated as equal — they mean the same thing to the dApp.
 */
export function connectionInfoEqual(
  a: ConnectionInfo | undefined,
  b: ConnectionInfo,
): boolean {
  if (!a) return false
  return (
    a.canUpload === b.canUpload &&
    !!a.storagePartitioned === !!b.storagePartitioned &&
    a.uploadMode === b.uploadMode &&
    // Compared, or a session whose reason changes while `uploadMode` stays
    // "unavailable" — a drive bought, a stamper that failed on retry — would
    // compute a new reason and never send it.
    a.uploadUnavailableReason === b.uploadUnavailableReason &&
    a.identity?.id === b.identity?.id &&
    a.identity?.name === b.identity?.name &&
    a.identity?.address === b.identity?.address &&
    a.identity?.publicKey === b.identity?.publicKey &&
    // Compared explicitly rather than assumed to follow the id: an avatar not
    // derived from the id could change while the id stays put.
    a.identity?.avatar.source === b.identity?.avatar.source &&
    a.identity?.avatar.url === b.identity?.avatar.url &&
    a.appKey?.address === b.appKey?.address &&
    a.appKey?.publicKey === b.appKey?.publicKey &&
    // A device id that changed is exactly the signal worth reporting: for a
    // partitioned session it means the storage holding it was evicted, and the
    // session rejoined the roster as a new device (#584, #570).
    a.deviceId === b.deviceId &&
    a.partition === b.partition
  )
}

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
    a.identity?.id === b.identity?.id &&
    a.identity?.name === b.identity?.name &&
    a.identity?.address === b.identity?.address &&
    a.identity?.publicKey === b.identity?.publicKey &&
    a.appKey?.address === b.appKey?.address &&
    a.appKey?.publicKey === b.appKey?.publicKey
  )
}

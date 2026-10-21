// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AccountSettings, AppPermissions, ConnectedApp } from "./types"

/**
 * What an app may do with the account-wide sharing key (#885): its own
 * pinned values, else the account defaults, else on. Write access never
 * outlives data sharing — the switch is only shown once data sharing is on.
 * One function for the proxy (which enforces it) and the identity UI (which
 * shows it), so the two cannot disagree.
 */
export function effectivePermissions(
  app: Pick<ConnectedApp, "dataSharing" | "writeAccess"> | undefined,
  settings: AccountSettings | undefined,
): AppPermissions {
  const dataSharing = app?.dataSharing ?? settings?.dataSharing ?? true
  return {
    dataSharing,
    writeAccess:
      dataSharing && (app?.writeAccess ?? settings?.writeAccess ?? true),
  }
}

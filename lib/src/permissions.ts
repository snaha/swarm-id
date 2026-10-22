// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  AccountSettings,
  AppPermissions,
  ConnectedApp,
  PermissionName,
} from "./types"

/** The account-wide default of a switch, what an unpinned app gets: on. */
export function sharingDefault(
  settings: AccountSettings | undefined,
  name: PermissionName,
): boolean {
  return settings?.[name] ?? true
}

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
  const dataSharing =
    app?.dataSharing ?? sharingDefault(settings, "dataSharing")
  return {
    dataSharing,
    writeAccess:
      dataSharing &&
      (app?.writeAccess ?? sharingDefault(settings, "writeAccess")),
  }
}

/**
 * The last-writer-wins clock each editable field rides, one per field, so
 * concurrent edits to different fields on different devices converge
 * instead of a stale copy of one clobbering the other (`merge-snapshot.ts`).
 */
export type FieldClocks = Readonly<Record<string, string>>

/** What an app holds: the drives (#862), the two switches and its session length (#885). */
export const GRANT_CLOCKS: FieldClocks = {
  drives: "permissionsAt",
  dataSharing: "dataSharingAt",
  writeAccess: "writeAccessAt",
  sessionDuration: "sessionDurationAt",
} satisfies Partial<Record<keyof ConnectedApp, keyof ConnectedApp>>

/** The account-wide switches; the rest of `settings` rides `settingsAt`. */
export const SETTINGS_CLOCKS: FieldClocks = {
  dataSharing: "dataSharingAt",
  writeAccess: "writeAccessAt",
} satisfies Partial<Record<keyof AccountSettings, keyof AccountSettings>>

/** `patch` with the clock of every field it names (even to `undefined`) set to `now`. */
export function stampClocks<T extends object>(
  patch: T,
  clocks: FieldClocks,
  now: number,
): T {
  const stamped: Record<string, unknown> = { ...(patch as object) }
  for (const field of Object.keys(patch)) {
    const clock = clocks[field]
    if (clock) stamped[clock] = now
  }
  return stamped as T
}

/** `winner`, with each clocked field (and its clock) taken from `loser` where the loser's clock is newer. */
export function overlayNewer<T extends object>(
  winner: T,
  loser: T,
  clocks: FieldClocks,
): T {
  const from = loser as Record<string, unknown>
  const merged: Record<string, unknown> = { ...(winner as object) }
  for (const [field, clock] of Object.entries(clocks)) {
    if (Number(from[clock] ?? 0) > Number(merged[clock] ?? 0)) {
      merged[field] = from[field]
      merged[clock] = from[clock]
    }
  }
  return merged as T
}

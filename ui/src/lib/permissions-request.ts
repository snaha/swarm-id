// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The "Permissions for <app>" page as data (#711): what a request or the
 * Apps tab opens it with, the rows it shows, and the grant a save writes.
 * Drives, and the two sharing switches (#885): the page reads `permissions`
 * whole, so one route carries them all.
 */
import { BatchId } from '@ethersphere/bee-js'
import {
  type AccountSettings,
  type AppPermissions,
  type ConnectedApp,
  type DriveRequirement,
  type PermissionName,
  type Permissions,
  PermissionsSchema,
  type PostageStamp,
  appSessionDuration,
} from '@snaha/swarm-id/internal'

import { type PickerRow, kindOf } from '$lib/drive-request'

/** The helper line under the app's primary drive when it is edited. */
const PRIMARY_DESCRIPTION = 'Where this app will store data'
const UNKNOWN_DRIVE_HEX_CHARS = 4
const KIND_DESCRIPTION = {
  regular: 'Used to store permanent data',
  scratch: 'Used to store streaming data',
} as const

export type Grant = ConnectedApp['drives']

export interface PermissionsPageRequest {
  appOrigin: string
  appName?: string
  appIcon?: string
  /** What the app asked for; absent when the user opened the page to edit. */
  permissions?: Permissions
  /** The account the app's session is with (a request names it). */
  accountId?: string
  /** The partitioned iframe's challenge, when it opened the popup. */
  challenge?: string
  /**
   * The app's session is partitioned and this popup was opened by the page,
   * not the iframe: only the account bus can carry the grant back.
   */
  handOverViaBus: boolean
}

/** Parse the page's URL hash; `undefined` without an origin. */
export function parsePermissionsHash(hash: string): PermissionsPageRequest | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const appOrigin = params.get('origin')
  if (!appOrigin) return undefined
  // A request that does not parse still opens as a request — with nothing to
  // grant — never as the Apps tab's editor of everything the app holds.
  let permissions: Permissions | undefined
  const raw = params.get('permissions')
  if (raw !== null) {
    try {
      const parsed = PermissionsSchema.safeParse(JSON.parse(raw))
      permissions = parsed.success ? parsed.data : {}
    } catch {
      permissions = {}
    }
  }
  return {
    appOrigin,
    appName: params.get('appName') ?? undefined,
    appIcon: params.get('appIcon') ?? undefined,
    permissions,
    accountId: params.get('account') ?? undefined,
    challenge: params.get('challenge') ?? undefined,
    handOverViaBus: params.get('handover') === 'bus',
  }
}

/**
 * Whether a request may grant to `app` at `now`: only to a live connection.
 * A plain Disconnect leaves the entry (no `revokedAt`) with `disconnectedAt`
 * set and the session fields cleared; an expired one has `connectedUntil`
 * in the past. Either would let any site open the page for a previously
 * connected origin and have one click grant it drives for its next connect.
 * Editing from the Apps tab is not gated on this: it lists disconnected
 * apps too, so a grant can be trimmed before the app reconnects.
 */
export function grantableOnRequest(app: ConnectedApp | undefined, now: number): boolean {
  return (
    app !== undefined &&
    app.disconnectedAt === undefined &&
    app.connectedUntil !== undefined &&
    app.connectedUntil > now
  )
}

/**
 * A request's rows: one per drive asked for, regular first, every one
 * starting empty. Nothing is required — saving with nothing chosen means
 * the user granted nothing.
 */
export function requestRows(requested: DriveRequirement[]): PickerRow[] {
  return [
    ...requested.filter((row) => row.kind === 'regular'),
    ...requested.filter((row) => row.kind === 'scratch'),
  ].map((row) => ({
    kind: row.kind,
    description: row.description ?? KIND_DESCRIPTION[row.kind],
    optional: true,
    chosen: '',
  }))
}

/**
 * The grant a request leaves: what the app held, plus what was chosen. A
 * grant that tracked the account default keeps that drive as its first, so
 * the primary does not move. `"all"` already covers anything.
 */
export function grantAfterRequest(
  current: Grant,
  defaultBatchHex: string | undefined,
  chosen: string[],
): Grant {
  if (chosen.length === 0 || current === 'all') return current
  const held =
    current === undefined
      ? defaultBatchHex
        ? [defaultBatchHex]
        : []
      : current.map((batch) => batch.toHex())
  return [...new Set([...held, ...chosen])].map(toBatchId)
}

/** The row label of a granted drive this device has no record of yet. */
export function unknownDriveLabel(batchHex: string): string {
  return `Drive ${batchHex.slice(0, UNKNOWN_DRIVE_HEX_CHARS)} (not on this device yet)`
}

/**
 * The rows the Apps tab edits: a grant that tracks the account default is
 * one Drive row on it; a list is a row per granted drive, each of which may
 * be set to "None" to take the drive away from the app. A granted drive this
 * device does not know (not yet synced from the device that bought it) is a
 * row too, so saving keeps it rather than dropping it unseen.
 */
export function editRows(
  current: Grant,
  drives: PostageStamp[],
  defaultBatchHex: string | undefined,
): PickerRow[] {
  if (current === 'all') return []
  if (current === undefined) {
    return [
      {
        kind: 'regular',
        description: PRIMARY_DESCRIPTION,
        optional: false,
        chosen: defaultBatchHex ?? '',
      },
    ]
  }
  return current.map((batch) => {
    const drive = drives.find((candidate) => candidate.batchID.equals(batch))
    const kind = drive ? kindOf(drive) : 'regular'
    return { kind, description: KIND_DESCRIPTION[kind], optional: true, chosen: batch.toHex() }
  })
}

/**
 * The grant an edit leaves. Unticking "all" falls back to the account
 * default; a grant that tracked the default keeps tracking it unless another
 * drive was picked.
 */
export function grantAfterEdit(
  current: Grant,
  rows: PickerRow[],
  allTicked: boolean,
  defaultBatchHex: string | undefined,
): Grant {
  if (current === 'all') return allTicked ? 'all' : undefined
  if (current === undefined) {
    const chosen = rows[0]?.chosen ?? ''
    return chosen === '' || chosen === defaultBatchHex ? undefined : [toBatchId(chosen)]
  }
  return rows.filter((row) => row.chosen !== '').map((row) => toBatchId(row.chosen))
}

/** Whether two grants name the same drives in the same order. */
export function sameGrant(a: Grant, b: Grant): boolean {
  if (a === undefined || b === undefined || a === 'all' || b === 'all') return a === b
  return a.length === b.length && a.every((batch, i) => batch.equals(b[i]))
}

function toBatchId(hex: string): BatchId {
  return new BatchId(hex)
}

// ----------------------------------------------------------------------------
// The sharing switches (#885)
// ----------------------------------------------------------------------------

export const PERMISSION_NAMES: readonly PermissionName[] = ['dataSharing', 'writeAccess']

/** The two switches as the designs word them (SwarmID-MVP, PERMISSIONS). */
export const SWITCH_COPY: Record<PermissionName, { label: string; description: string }> = {
  dataSharing: {
    label: 'Data sharing',
    description: 'Allow this app to access data shared by other apps',
  },
  writeAccess: {
    label: 'Write access',
    description: 'Allow this app to share data with other apps',
  },
}

/** The account-wide default of a switch: what an unpinned app gets. */
export function sharingDefault(
  settings: AccountSettings | undefined,
  name: PermissionName,
): boolean {
  return settings?.[name] ?? true
}

/**
 * What each switch shows: the app's pin, else the account default. Each on
 * its own — write access is only SHOWN once data sharing is on, which is how
 * the implication is kept, so its own value need not follow.
 */
export function switchValues(
  app: Pick<ConnectedApp, 'dataSharing' | 'writeAccess'> | undefined,
  settings: AccountSettings | undefined,
): AppPermissions {
  return {
    dataSharing: app?.dataSharing ?? sharingDefault(settings, 'dataSharing'),
    writeAccess: app?.writeAccess ?? sharingDefault(settings, 'writeAccess'),
  }
}

/**
 * Which switches a request names: the ones asked for, data sharing whenever
 * write access is, since the latter implies it. Both for no request (an
 * edit).
 */
export function switchesToShow(requested: Permissions | undefined): PermissionName[] {
  if (requested === undefined) return [...PERMISSION_NAMES]
  const names: PermissionName[] = []
  if (requested.dataSharing || requested.writeAccess) names.push('dataSharing')
  if (requested.writeAccess) names.push('writeAccess')
  return names
}

/**
 * The switches a request asks for that are not already on — the ones the
 * connect screen and the permissions popup put the question for (#885).
 * Write access is listed while data sharing is off: it is only SHOWN once
 * data sharing is on, which the caller keeps live as the user flips it.
 */
export function switchesToAsk(
  requested: Permissions | undefined,
  current: AppPermissions,
): PermissionName[] {
  const effective = askedValues(current)
  return switchesToShow(requested).filter((name) => !effective[name])
}

/**
 * What the asked switches show at first: the effective values, so write
 * access reads off while data sharing is, whatever it would be underneath.
 */
export function askedValues(raw: AppPermissions): AppPermissions {
  return { dataSharing: raw.dataSharing, writeAccess: raw.dataSharing && raw.writeAccess }
}

/**
 * The pins an ask leaves: each switch asked and moved off its underlying
 * value — and a write access asked and left off while data sharing was
 * turned on, since the user declined it. A switch not asked, or left
 * disabled (data sharing still off), was not decided, so it is not pinned.
 */
export function askedPatch(
  raw: AppPermissions,
  shown: AppPermissions,
  asked: readonly PermissionName[],
  settings: AccountSettings | undefined,
): Partial<Pick<ConnectedApp, 'dataSharing' | 'writeAccess'>> {
  const decided = {
    dataSharing: asked.includes('dataSharing') ? shown.dataSharing : raw.dataSharing,
    writeAccess:
      asked.includes('writeAccess') && shown.dataSharing ? shown.writeAccess : raw.writeAccess,
  }
  return sharingAfterSave(raw, decided, [], settings)
}

/**
 * Whether the app holds anything of its own apart from the account defaults
 * — a sharing switch pinned the other way, or its own session duration — the
 * Apps tab's "Custom permissions" badge.
 */
export function customised(
  app: Pick<ConnectedApp, 'dataSharing' | 'writeAccess' | 'sessionDuration'>,
  settings: AccountSettings | undefined,
): boolean {
  return (
    pinnedDifferently(app, settings).length > 0 ||
    (app.sessionDuration !== undefined && app.sessionDuration !== appSessionDuration(settings))
  )
}

/** The switches an app pins to something other than the account default. */
export function pinnedDifferently(
  app: Pick<ConnectedApp, 'dataSharing' | 'writeAccess'>,
  settings: AccountSettings | undefined,
): PermissionName[] {
  return PERMISSION_NAMES.filter(
    (name) => app[name] !== undefined && app[name] !== sharingDefault(settings, name),
  )
}

/**
 * The sharing patch a save writes: a pin for each switch moved off what it
 * showed, a cleared pin (`undefined`) for one put back to the account default
 * after "Use account default", nothing for the rest — an untouched switch
 * keeps following, or stays pinned, as it was.
 */
export function sharingAfterSave(
  initial: AppPermissions,
  values: AppPermissions,
  resets: readonly PermissionName[],
  settings: AccountSettings | undefined,
): Partial<Pick<ConnectedApp, 'dataSharing' | 'writeAccess'>> {
  const patch: Partial<Pick<ConnectedApp, 'dataSharing' | 'writeAccess'>> = {}
  for (const name of PERMISSION_NAMES) {
    if (resets.includes(name) && values[name] === sharingDefault(settings, name)) {
      patch[name] = undefined
    } else if (values[name] !== initial[name]) {
      patch[name] = values[name]
    }
  }
  return patch
}

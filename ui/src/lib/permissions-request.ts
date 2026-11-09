// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The "Permissions for <app>" page as data: what a request or the
 * Apps tab opens it with, the rows it shows, and the grant a save writes.
 * Drives, and the two sharing switches: the page reads `permissions`
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
  effectivePermissions,
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

/**
 * The drives an app can write to under `grant`, as batch hexes: no grant
 * means the account default (the one the lib resolves, so pass the explicit
 * default, not a fallback), `"all"` every drive on this device. A listed
 * drive this device does not know yet is included; a deleted one is not, so
 * pass the stamps with their tombstones.
 */
export function writableBatches(
  grant: Grant,
  stamps: PostageStamp[],
  defaultBatchHex: string | undefined,
): string[] {
  const deleted = new Set(
    stamps.filter((stamp) => stamp.deletedAt !== undefined).map((stamp) => stamp.batchID.toHex()),
  )
  const hexes =
    grant === 'all'
      ? stamps.map((stamp) => stamp.batchID.toHex())
      : grant === undefined
        ? defaultBatchHex
          ? [defaultBatchHex]
          : []
        : grant.map((batch) => batch.toHex())
  return hexes.filter((hex) => !deleted.has(hex))
}

/**
 * The drives an app can write to under `before` and no longer can under
 * `after`, as batch hexes. A drive this device does not know yet is
 * named too: losing it unseen is the case most worth a warning. A deleted
 * one is not: there is nothing left on it to lose.
 */
export function drivesTakenAway(
  before: Grant,
  after: Grant,
  stamps: PostageStamp[],
  defaultBatchHex: string | undefined,
): string[] {
  const kept = new Set(writableBatches(after, stamps, defaultBatchHex))
  return writableBatches(before, stamps, defaultBatchHex).filter((hex) => !kept.has(hex))
}

/** Whether two grants name the same drives in the same order. */
export function sameGrant(a: Grant, b: Grant): boolean {
  if (a === undefined || b === undefined || a === 'all' || b === 'all') return a === b
  return a.length === b.length && a.every((batch, i) => batch.equals(b[i]))
}

/**
 * The grant an Apps-tab drive row edit proposes. A drive made through a
 * row's "Add new drive…" (`added`) joins the grant rather than replacing
 * that row's drive: the user bought it for this app, and was not asking to
 * take the other away.
 */
export function grantAfterRowEdit(
  current: Grant,
  rows: PickerRow[],
  defaultBatchHex: string | undefined,
  explicitDefaultHex: string | undefined,
  added?: string,
): Grant {
  return added === undefined
    ? grantAfterEdit(current, rows, current === 'all', defaultBatchHex)
    : grantAfterRequest(current, explicitDefaultHex, [added])
}

/**
 * What a confirmed edit saves: its grant, or nothing when the app's grant
 * moved while the dialog was open (another device, the permissions popup),
 * so that change is not overwritten.
 */
export function grantToConfirm(before: Grant, now: Grant, proposed: Grant): Grant | 'stale' {
  return sameGrant(before, now) ? proposed : 'stale'
}

function toBatchId(hex: string): BatchId {
  return new BatchId(hex)
}

// ----------------------------------------------------------------------------
// The sharing switches
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

/**
 * The switches a request asks for that are not in effect (`current`, from
 * `effectivePermissions`) — the ones the connect screen and the permissions
 * popup put the question for. Data sharing is asked whenever write
 * access is, since the latter implies it; write access is listed while data
 * sharing is off, shown disabled until the user turns data sharing on.
 */
export function switchesToAsk(
  requested: Permissions | undefined,
  current: AppPermissions,
): PermissionName[] {
  const names: PermissionName[] = []
  if (requested?.dataSharing || requested?.writeAccess) names.push('dataSharing')
  if (requested?.writeAccess) names.push('writeAccess')
  return names.filter((name) => !current[name])
}

/**
 * The pins an ask leaves, `initial` being what was in effect when the screen
 * opened and `shown` what it shows at save: data sharing when asked and
 * moved; write access when asked, enabled and moved — and, whenever data
 * sharing was just turned on, to what the screen showed: off unless it was
 * asked and turned on. The screen showed write access off, or not at all,
 * and what sits underneath (the account default, an old pin) is not what the
 * user agreed to.
 */
export function askedPatch(
  initial: AppPermissions,
  shown: AppPermissions,
  asked: readonly PermissionName[],
): Partial<Pick<ConnectedApp, 'dataSharing' | 'writeAccess'>> {
  const patch: Partial<Pick<ConnectedApp, 'dataSharing' | 'writeAccess'>> = {}
  if (asked.includes('dataSharing') && shown.dataSharing !== initial.dataSharing) {
    patch.dataSharing = shown.dataSharing
  }
  const writeAsked = asked.includes('writeAccess') && shown.dataSharing
  const writeAccess = writeAsked && shown.writeAccess
  const dataSharingTurnedOn = shown.dataSharing && !initial.dataSharing
  if (dataSharingTurnedOn || (writeAsked && writeAccess !== initial.writeAccess)) {
    patch.writeAccess = writeAccess
  }
  return patch
}

/**
 * Whether the app holds anything of its own apart from the account defaults
 * — a pinned switch or its own session length — the Apps tab's "Custom
 * permissions" badge. A pin equal to the default counts: the app no longer
 * follows the account, so turning a switch off account-wide leaves it be.
 */
export function customised(
  app: Pick<ConnectedApp, 'dataSharing' | 'writeAccess' | 'sessionDuration'>,
  settings: AccountSettings | undefined,
): boolean {
  return pinned(app, settings).length > 0 || app.sessionDuration !== undefined
}

/**
 * The switches an app pins. Write access counts only while data sharing is
 * in effect: without it the pin changes nothing and has no row to be seen
 * on, so it is not custom — it is kept, and shows again once data sharing is
 * back on.
 */
export function pinned(
  app: Pick<ConnectedApp, 'dataSharing' | 'writeAccess'>,
  settings: AccountSettings | undefined,
): PermissionName[] {
  const { dataSharing } = effectivePermissions(app, settings)
  return PERMISSION_NAMES.filter(
    (name) => app[name] !== undefined && (name !== 'writeAccess' || dataSharing),
  )
}

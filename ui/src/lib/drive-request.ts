// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The connect screen's drive picker, as data (#862): one row per drive the
 * app asked for, regular rows first, then scratch. The page renders rows;
 * this decides what each row starts with, may pick, and amounts to.
 */
import type { DriveKind } from '@snaha/swarm-id'
import { type DriveRequirement, type PostageStamp, isScratchDrive } from '@snaha/swarm-id/internal'

/** The select entry that opens the Add drive dialog for the row. */
export const ADD_NEW_DRIVE = '__add-new-drive__'

export interface PickerRow {
  kind: DriveKind
  description: string
  optional: boolean
  /** The chosen drive's batch id, or empty for none. */
  chosen: string
}

/** The drive types as the Add drive dialog and the drive card name them. */
export const DRIVE_KIND_LABEL: Record<DriveKind, string> = {
  regular: 'Regular',
  scratch: 'Scratch',
}
export const DRIVE_KIND_DESCRIPTION: Record<DriveKind, string> = {
  regular: 'Stores data permanently, no overwrites',
  scratch: 'Data can be overwritten, ideal for streaming and live feeds',
}

const DEFAULT_DESCRIPTION: Record<DriveKind, string> = {
  regular: 'Used to store permanent data',
  scratch: 'Used to store streaming data',
}

export function kindOf(drive: PostageStamp): DriveKind {
  return isScratchDrive(drive) ? 'scratch' : 'regular'
}

/** Rows for a requested list, regular first, before any drive is picked. */
function requestedRows(request: DriveRequirement[]): PickerRow[] {
  return [
    ...request.filter((row) => row.kind === 'regular'),
    ...request.filter((row) => row.kind === 'scratch'),
  ].map((requirement) => ({
    kind: requirement.kind,
    description: requirement.description ?? DEFAULT_DESCRIPTION[requirement.kind],
    optional: requirement.optional === true,
    chosen: '',
  }))
}

/**
 * Every required row still empty takes a drive of its kind no other row holds
 * — the account default when it is free — so the common case needs no click.
 * An optional row is left as it is, and never blocks. Returns `rows` itself
 * when nothing was filled, so a caller re-running this as drives arrive from
 * another tab (#879) can tell a change from none.
 */
export function fillRequiredRows(
  rows: PickerRow[],
  drives: PostageStamp[],
  defaultBatchHex: string | undefined,
): PickerRow[] {
  const held = new Set(rows.map((row) => row.chosen).filter((chosen) => chosen !== ''))
  let filled = false
  const next = rows.map((row) => {
    if (row.optional || row.chosen !== '') return row
    const free = drives.filter(
      (drive) => kindOf(drive) === row.kind && !held.has(drive.batchID.toHex()),
    )
    const first = free.find((drive) => drive.batchID.toHex() === defaultBatchHex) ?? free[0]
    if (!first) return row
    held.add(first.batchID.toHex())
    filled = true
    return { ...row, chosen: first.batchID.toHex() }
  })
  return filled ? next : rows
}

/** Rows for a requested list, each required row started where it can be. */
export function pickerRows(
  request: DriveRequirement[],
  drives: PostageStamp[],
  defaultBatchHex: string | undefined,
): PickerRow[] {
  return fillRequiredRows(requestedRows(request), drives, defaultBatchHex)
}

/** The drives a row may pick: its kind, minus what the other rows hold. */
export function rowChoices(
  rows: PickerRow[],
  index: number,
  drives: PostageStamp[],
): PostageStamp[] {
  const held = new Set(rows.filter((_, i) => i !== index).map((row) => row.chosen))
  return drives.filter(
    (drive) => kindOf(drive) === rows[index].kind && !held.has(drive.batchID.toHex()),
  )
}

/** Every required row holds a drive. */
export function rowsComplete(rows: PickerRow[]): boolean {
  return rows.every((row) => row.optional || row.chosen !== '')
}

/** The grant the rows amount to, in row order; empty rows are left out. */
export function rowsGrant(rows: PickerRow[]): string[] {
  return rows.filter((row) => row.chosen !== '').map((row) => row.chosen)
}

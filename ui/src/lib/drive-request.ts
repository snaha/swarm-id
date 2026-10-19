// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The connect screen's drive picker, as data (#862): one row per drive the
 * app asked for, regular rows first, then scratch. The page renders rows;
 * this decides what each row starts with, may pick, and amounts to.
 */
import { type DriveRequirement, type PostageStamp, isScratchDrive } from '@snaha/swarm-id/internal'

export type DriveKind = 'regular' | 'scratch'

/** The select entry that opens the Add drive dialog for the row. */
export const ADD_NEW_DRIVE = '__add-new-drive__'

export interface PickerRow {
  kind: DriveKind
  description: string
  optional: boolean
  /** The chosen drive's batch id, or empty for none. */
  chosen: string
}

const DEFAULT_DESCRIPTION: Record<DriveKind, string> = {
  regular: 'Used to store permanent data',
  scratch: 'Used to store streaming data',
}

export function kindOf(drive: PostageStamp): DriveKind {
  return isScratchDrive(drive) ? 'scratch' : 'regular'
}

/**
 * Rows for a requested list. A required row starts on a drive of its kind no
 * earlier row holds — the account default when it is free — so the common
 * case needs no click; an optional row starts empty, and never blocks.
 */
export function pickerRows(
  request: DriveRequirement[],
  drives: PostageStamp[],
  defaultBatchHex: string | undefined,
): PickerRow[] {
  const ordered = [
    ...request.filter((row) => row.kind === 'regular'),
    ...request.filter((row) => row.kind === 'scratch'),
  ]
  const held = new Set<string>()
  return ordered.map((requirement) => {
    const { kind } = requirement
    const optional = requirement.optional === true
    let chosen = ''
    if (!optional) {
      const free = drives.filter(
        (drive) => kindOf(drive) === kind && !held.has(drive.batchID.toHex()),
      )
      const first = free.find((drive) => drive.batchID.toHex() === defaultBatchHex) ?? free[0]
      if (first) {
        chosen = first.batchID.toHex()
        held.add(chosen)
      }
    }
    return {
      kind,
      description: requirement.description ?? DEFAULT_DESCRIPTION[kind],
      optional,
      chosen,
    }
  })
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

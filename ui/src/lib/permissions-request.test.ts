// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id/internal'
import { describe, expect, it } from 'vitest'

import {
  askedPatch,
  askedValues,
  customised,
  editRows,
  grantAfterEdit,
  grantAfterRequest,
  grantableOnRequest,
  parsePermissionsHash,
  pinnedDifferently,
  requestRows,
  sharingAfterSave,
  switchValues,
  switchesToAsk,
  switchesToShow,
  unknownDriveLabel,
} from '$lib/permissions-request'

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const S = 'cc'.repeat(32)
const hex = (grant: unknown) =>
  Array.isArray(grant) ? grant.map((batch: BatchId) => batch.toHex()) : grant

function drive(batchHex: string, kind?: 'scratch'): PostageStamp {
  return {
    batchID: new BatchId(batchHex),
    signerKey: new PrivateKey('11'.repeat(32)),
    utilization: 0,
    usable: true,
    depth: 20,
    amount: 1n,
    bucketDepth: 16,
    blockNumber: 1,
    immutableFlag: false,
    exists: true,
    createdAt: 1,
    kind,
  }
}

describe('parsePermissionsHash', () => {
  it('reads a request, and opens a malformed one as a request with nothing to grant', () => {
    const permissions = encodeURIComponent(JSON.stringify({ drives: [{ kind: 'scratch' }] }))
    expect(
      parsePermissionsHash(
        `#origin=https%3A%2F%2Fapp.example&permissions=${permissions}&account=${A}`,
      ),
    ).toMatchObject({
      appOrigin: 'https://app.example',
      permissions: { drives: [{ kind: 'scratch' }] },
      accountId: A,
    })
    expect(parsePermissionsHash('#origin=x&permissions=%7Bbroken')?.permissions).toEqual({})
    expect(parsePermissionsHash('#origin=x')?.permissions).toBeUndefined()
    expect(parsePermissionsHash('#origin=x&handover=bus')?.handOverViaBus).toBe(true)
    expect(parsePermissionsHash('#origin=x')?.handOverViaBus).toBe(false)
    expect(parsePermissionsHash('#account=x')).toBeUndefined()
  })
})

describe('a request', () => {
  // The page grants on request to a live session only (#883 review): a
  // disconnected entry stays in the record, and so does an expired one.
  it('grants only to an app with a live connection', () => {
    const NOW = 1_000
    const live = { appUrl: 'https://app.example', appName: 'App', lastConnectedAt: 1 }
    expect(grantableOnRequest({ ...live, connectedUntil: NOW + 1 }, NOW)).toBe(true)
    expect(grantableOnRequest({ ...live, connectedUntil: NOW }, NOW)).toBe(false)
    expect(grantableOnRequest({ ...live, connectedUntil: NOW + 1, disconnectedAt: 5 }, NOW)).toBe(
      false,
    )
    expect(grantableOnRequest(live, NOW)).toBe(false)
    expect(grantableOnRequest(undefined, NOW)).toBe(false)
  })

  it('shows each asked drive, regular first, all of them empty and none required', () => {
    const rows = requestRows([{ kind: 'scratch' }, { kind: 'regular', description: 'Messages' }])
    expect(rows.map((row) => [row.kind, row.description, row.chosen, row.optional])).toEqual([
      ['regular', 'Messages', '', true],
      ['scratch', 'Used to store streaming data', '', true],
    ])
  })

  it('adds to the grant, keeps a tracked default first, and changes nothing when nothing was chosen', () => {
    expect(hex(grantAfterRequest([new BatchId(A)], A, [S]))).toEqual([A, S])
    expect(hex(grantAfterRequest(undefined, A, [S]))).toEqual([A, S])
    expect(hex(grantAfterRequest([new BatchId(A)], A, [A]))).toEqual([A])
    expect(grantAfterRequest(undefined, A, [])).toBeUndefined()
    expect(grantAfterRequest('all', A, [S])).toBe('all')
  })
})

describe('an edit', () => {
  const drives = [drive(A), drive(B), drive(S, 'scratch')]

  it('shows a tracked default as one Drive row, and a list as a row per granted drive', () => {
    expect(editRows(undefined, drives, A).map((row) => row.chosen)).toEqual([A])
    expect(
      editRows([new BatchId(A), new BatchId(S)], drives, A).map((row) => [row.kind, row.chosen]),
    ).toEqual([
      ['regular', A],
      ['scratch', S],
    ])
  })

  // A drive granted on another device may not have synced here yet: it is
  // still a row, so a save keeps it unless the user sets it to None.
  it('keeps a granted drive this device does not know, as a row of its own', () => {
    const rows = editRows([new BatchId(A), new BatchId(B)], [drive(A)], A)
    expect(rows.map((row) => [row.kind, row.chosen])).toEqual([
      ['regular', A],
      ['regular', B],
    ])
    expect(hex(grantAfterEdit([new BatchId(A), new BatchId(B)], rows, false, A))).toEqual([A, B])
    expect(unknownDriveLabel(B)).toBe('Drive bbbb (not on this device yet)')
  })

  it('takes away a drive set to None, and keeps tracking the default unless another was picked', () => {
    const rows = editRows([new BatchId(A), new BatchId(S)], drives, A)
    rows[1].chosen = ''
    expect(hex(grantAfterEdit([new BatchId(A), new BatchId(S)], rows, false, A))).toEqual([A])

    const tracked = editRows(undefined, drives, A)
    expect(grantAfterEdit(undefined, tracked, false, A)).toBeUndefined()
    tracked[0].chosen = B
    expect(hex(grantAfterEdit(undefined, tracked, false, A))).toEqual([B])
  })

  it('falls back to the account default when "all" is unticked', () => {
    expect(grantAfterEdit('all', [], true, A)).toBe('all')
    expect(grantAfterEdit('all', [], false, A)).toBeUndefined()
  })
})

// #885: the two sharing switches beside the drives.
describe('the sharing switches', () => {
  it('show the pin, else the account default, else on', () => {
    expect(switchValues(undefined, undefined)).toEqual({ dataSharing: true, writeAccess: true })
    expect(switchValues({}, { dataSharing: false })).toEqual({
      dataSharing: false,
      writeAccess: true,
    })
    expect(switchValues({ writeAccess: false }, { writeAccess: true })).toEqual({
      dataSharing: true,
      writeAccess: false,
    })
  })

  it('are both shown on an edit, and on a request only what was asked, write access implying data sharing', () => {
    expect(switchesToShow(undefined)).toEqual(['dataSharing', 'writeAccess'])
    expect(switchesToShow({ drives: [] })).toEqual([])
    expect(switchesToShow({ dataSharing: true })).toEqual(['dataSharing'])
    expect(switchesToShow({ writeAccess: true })).toEqual(['dataSharing', 'writeAccess'])
  })

  it('are asked for only while effectively off', () => {
    const on = { dataSharing: true, writeAccess: true }
    expect(switchesToAsk({ dataSharing: true, writeAccess: true }, on)).toEqual([])
    expect(switchesToAsk({ writeAccess: true }, { dataSharing: true, writeAccess: false })).toEqual(
      ['writeAccess'],
    )
    // Write access underneath is on, but data sharing is off: both are asked.
    expect(switchesToAsk({ writeAccess: true }, { dataSharing: false, writeAccess: true })).toEqual(
      ['dataSharing', 'writeAccess'],
    )
    expect(askedValues({ dataSharing: false, writeAccess: true })).toEqual({
      dataSharing: false,
      writeAccess: false,
    })
  })

  it('pin what an ask decided, and not a write access left disabled or never asked', () => {
    const raw = { dataSharing: false, writeAccess: true }
    const both = ['dataSharing', 'writeAccess'] as const
    // Nothing touched: nothing pinned, write access was never enabled.
    expect(askedPatch(raw, { dataSharing: false, writeAccess: false }, both, undefined)).toEqual({})
    // Data sharing on, write access left off: declined, so pinned off.
    expect(askedPatch(raw, { dataSharing: true, writeAccess: false }, both, undefined)).toEqual({
      dataSharing: true,
      writeAccess: false,
    })
    // Both on: write access follows the default it already matches.
    expect(askedPatch(raw, { dataSharing: true, writeAccess: true }, both, undefined)).toEqual({
      dataSharing: true,
    })
    // Only data sharing asked: write access, off on screen, is not its decision.
    expect(
      askedPatch(raw, { dataSharing: true, writeAccess: false }, ['dataSharing'], undefined),
    ).toEqual({ dataSharing: true })
  })

  it('count a differing pin or an own session length as custom', () => {
    expect(customised({}, undefined)).toBe(false)
    expect(customised({ dataSharing: false }, undefined)).toBe(true)
    expect(customised({ sessionDuration: 7 }, undefined)).toBe(true)
    expect(customised({ sessionDuration: 7 }, { appSessionDuration: 7 })).toBe(false)
  })

  it('tell a pin that differs from the account default from one that matches it', () => {
    expect(pinnedDifferently({}, undefined)).toEqual([])
    expect(pinnedDifferently({ dataSharing: true }, undefined)).toEqual([])
    expect(pinnedDifferently({ dataSharing: false }, undefined)).toEqual(['dataSharing'])
    expect(pinnedDifferently({ writeAccess: true }, { writeAccess: false })).toEqual([
      'writeAccess',
    ])
  })

  // Asked for both at connect, write access declined, data sharing turned off
  // again on the app's page: the write pin can neither act nor be seen, so the
  // app is not custom — until data sharing is back on.
  it('do not count a write access pin while data sharing is off', () => {
    const app = { dataSharing: false, writeAccess: false }
    expect(pinnedDifferently(app, { dataSharing: false })).toEqual([])
    expect(customised(app, { dataSharing: false })).toBe(false)
    expect(pinnedDifferently({ writeAccess: false }, { dataSharing: false })).toEqual([])
    expect(
      pinnedDifferently({ dataSharing: true, writeAccess: false }, { dataSharing: false }),
    ).toEqual(['writeAccess'])
  })

  it('save a pin for a switch moved, clear one reset to the default, and leave the rest alone', () => {
    const initial = { dataSharing: false, writeAccess: true }
    expect(sharingAfterSave(initial, initial, [], undefined)).toEqual({})
    expect(
      sharingAfterSave(initial, { dataSharing: true, writeAccess: true }, [], undefined),
    ).toEqual({ dataSharing: true })
    // "Use account default" put it back to the default (on): the pin goes.
    const reset = sharingAfterSave(
      initial,
      { dataSharing: true, writeAccess: true },
      ['dataSharing'],
      undefined,
    )
    expect(reset).toEqual({ dataSharing: undefined })
    expect('dataSharing' in reset).toBe(true)
    // Reset, then moved off the default again: a pin, as if never reset.
    expect(
      sharingAfterSave(
        { dataSharing: true, writeAccess: true },
        { dataSharing: false, writeAccess: true },
        ['dataSharing'],
        undefined,
      ),
    ).toEqual({ dataSharing: false })
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id/internal'
import { describe, expect, it } from 'vitest'

import {
  askedPatch,
  customised,
  editRows,
  grantAfterEdit,
  grantAfterRequest,
  grantableOnRequest,
  parsePermissionsHash,
  pinned,
  requestRows,
  switchesToAsk,
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
  const off = { dataSharing: false, writeAccess: false, revealSecrets: false }
  const readOnly = { dataSharing: true, writeAccess: false, revealSecrets: false }
  const both = ['dataSharing', 'writeAccess'] as const

  it('are asked for only while not in effect, data sharing along with write access', () => {
    const on = { dataSharing: true, writeAccess: true, revealSecrets: false }
    expect(switchesToAsk(undefined, off)).toEqual([])
    expect(switchesToAsk({ drives: [] }, off)).toEqual([])
    expect(switchesToAsk({ dataSharing: true, writeAccess: true }, on)).toEqual([])
    expect(switchesToAsk({ dataSharing: true }, off)).toEqual(['dataSharing'])
    expect(switchesToAsk({ writeAccess: true }, readOnly)).toEqual(['writeAccess'])
    expect(switchesToAsk({ writeAccess: true }, off)).toEqual(['dataSharing', 'writeAccess'])
  })

  // #889: key export stands alone — asked when requested and off, pinned
  // when the user turned it on, untouched by the sharing switches.
  it('ask for key export on its own, and pin it when moved', () => {
    const noExport = { dataSharing: true, writeAccess: true, revealSecrets: false }
    expect(switchesToAsk({ revealSecrets: true }, noExport)).toEqual(['revealSecrets'])
    expect(switchesToAsk({ revealSecrets: true }, { ...noExport, revealSecrets: true })).toEqual([])
    expect(askedPatch(noExport, { ...noExport, revealSecrets: true }, ['revealSecrets'])).toEqual({
      revealSecrets: true,
    })
    expect(askedPatch(noExport, { ...noExport, revealSecrets: true }, both)).toEqual({})
  })

  it('pin what an ask moved', () => {
    expect(askedPatch(off, off, both)).toEqual({})
    expect(askedPatch(readOnly, readOnly, ['writeAccess'])).toEqual({})
    expect(
      askedPatch(readOnly, { dataSharing: true, writeAccess: true, revealSecrets: false }, [
        'writeAccess',
      ]),
    ).toEqual({ writeAccess: true })
  })

  // The screen showed write access off (or not at all) while data sharing
  // was off, whatever the account default or an old pin says underneath:
  // turning data sharing on grants exactly what was shown.
  it('pin write access to what was shown once data sharing is turned on', () => {
    expect(
      askedPatch(off, { dataSharing: true, writeAccess: false, revealSecrets: false }, both),
    ).toEqual({
      dataSharing: true,
      writeAccess: false,
    })
    expect(
      askedPatch(off, { dataSharing: true, writeAccess: true, revealSecrets: false }, both),
    ).toEqual({
      dataSharing: true,
      writeAccess: true,
    })
    expect(
      askedPatch(off, { dataSharing: true, writeAccess: false, revealSecrets: false }, [
        'dataSharing',
      ]),
    ).toEqual({
      dataSharing: true,
      writeAccess: false,
    })
  })

  // A pin equal to the account default is a pin: the app no longer follows
  // the account, so it is shown as custom and offered the default back.
  it('count any pin, or an own session length, as custom', () => {
    expect(customised({}, undefined)).toBe(false)
    expect(customised({ dataSharing: false }, undefined)).toBe(true)
    expect(customised({ dataSharing: true }, undefined)).toBe(true)
    expect(customised({ sessionDuration: 7 }, { appSessionDuration: 7 })).toBe(true)
  })

  // Asked for both at connect, write access declined, data sharing turned off
  // again on the app's page: the write pin can neither act nor be seen, so the
  // app is not custom — until data sharing is back on.
  it('do not count a write access pin while data sharing is off', () => {
    expect(pinned({ dataSharing: false, writeAccess: false }, undefined)).toEqual(['dataSharing'])
    expect(pinned({ writeAccess: false }, { dataSharing: false })).toEqual([])
    expect(customised({ writeAccess: false }, { dataSharing: false })).toBe(false)
    expect(pinned({ dataSharing: true, writeAccess: false }, { dataSharing: false })).toEqual([
      'dataSharing',
      'writeAccess',
    ])
  })
})

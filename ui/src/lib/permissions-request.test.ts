// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id/internal'
import { describe, expect, it } from 'vitest'

import {
  editRows,
  grantAfterEdit,
  grantAfterRequest,
  parsePermissionsHash,
  requestRows,
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
    expect(parsePermissionsHash('#account=x')).toBeUndefined()
  })
})

describe('a request', () => {
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

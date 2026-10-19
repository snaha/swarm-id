// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id/internal'
import { describe, expect, it } from 'vitest'

import { pickerRows, rowChoices, rowsComplete, rowsGrant } from '$lib/drive-request'

const REGULAR_A = 'aa'.repeat(32)
const REGULAR_B = 'bb'.repeat(32)
const SCRATCH_C = 'cc'.repeat(32)

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

const DRIVES = [drive(REGULAR_A), drive(REGULAR_B), drive(SCRATCH_C, 'scratch')]

describe('pickerRows', () => {
  it('orders regulars first and starts each required row on a free drive of its kind, the default first', () => {
    const rows = pickerRows(
      [
        { kind: 'scratch' },
        { kind: 'regular' },
        { kind: 'regular', description: 'Used to store your messages' },
      ],
      DRIVES,
      REGULAR_B,
    )
    expect(rows.map((row) => [row.kind, row.chosen])).toEqual([
      ['regular', REGULAR_B],
      ['regular', REGULAR_A],
      ['scratch', SCRATCH_C],
    ])
    expect(rows.map((row) => row.description)).toEqual([
      'Used to store permanent data',
      'Used to store your messages',
      'Used to store streaming data',
    ])
  })

  it('leaves an optional row empty, and a required row with nothing of its kind to add', () => {
    const rows = pickerRows(
      [{ kind: 'scratch', optional: true }, { kind: 'regular' }],
      [drive(REGULAR_A), drive(REGULAR_B)],
      undefined,
    )
    expect(rows.map((row) => row.chosen)).toEqual([REGULAR_A, ''])
    expect(rowsComplete(rows)).toBe(true)

    const required = pickerRows([{ kind: 'scratch' }], [drive(REGULAR_A)], REGULAR_A)
    expect(required[0].chosen).toBe('')
    expect(rowsComplete(required)).toBe(false)
  })
})

describe('rowChoices', () => {
  it('offers a row its kind, minus what the other rows hold', () => {
    const rows = pickerRows([{ kind: 'regular' }, { kind: 'regular' }], DRIVES, REGULAR_A)
    expect(rowChoices(rows, 1, DRIVES).map((d) => d.batchID.toHex())).toEqual([REGULAR_B])
    expect(rowChoices(rows, 0, DRIVES).map((d) => d.batchID.toHex())).toEqual([REGULAR_A])
  })
})

describe('rowsGrant', () => {
  it('lists the chosen drives in row order and skips empty optional rows', () => {
    const rows = pickerRows(
      [{ kind: 'scratch', optional: true }, { kind: 'regular' }],
      DRIVES,
      REGULAR_B,
    )
    expect(rowsGrant(rows)).toEqual([REGULAR_B])
    expect(rowsGrant([])).toEqual([])
  })
})

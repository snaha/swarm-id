// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type PendingOperation, nullJournal, operationJournal } from './operation-journal.svelte'

// The module persists only in the browser; the fake below stands in for the
// storage it writes to, so the reload assertion tests the real path.
vi.mock('$app/environment', () => ({ browser: true }))

const stored = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  clear: () => stored.clear(),
})

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const BATCH = 'f9'.repeat(32)
const OTHER_BATCH = 'a1'.repeat(32)

const purchase: PendingOperation = {
  kind: 'purchase',
  accountId: ACCOUNT,
  batchId: BATCH,
  name: 'Photos',
  startedAt: 1,
}

beforeEach(() => {
  stored.clear()
  for (const entry of operationJournal.entries()) {
    operationJournal.clear(entry.accountId, entry.batchId)
  }
})

describe('operationJournal', () => {
  it('finds an entry by account and batch', () => {
    operationJournal.record(purchase)
    expect(operationJournal.find(ACCOUNT, BATCH)).toEqual(purchase)
    expect(operationJournal.find(ACCOUNT, OTHER_BATCH)).toBeUndefined()
    expect(operationJournal.find('0xsomeone-else', BATCH)).toBeUndefined()
  })

  // A retry of the same purchase must not leave two entries behind, or the
  // Storage tab would offer to finish the same drive twice.
  it('replaces the entry for a batch rather than accumulating', () => {
    operationJournal.record({ ...purchase, name: 'Old name' })
    operationJournal.record(purchase)
    expect(operationJournal.entries()).toEqual([purchase])
  })

  it('keeps entries for other batches when one is cleared', () => {
    operationJournal.record(purchase)
    operationJournal.record({ ...purchase, batchId: OTHER_BATCH })
    operationJournal.clear(ACCOUNT, BATCH)
    expect(operationJournal.entries().map((entry) => entry.batchId)).toEqual([OTHER_BATCH])
  })

  it('survives a reload', () => {
    operationJournal.record(purchase)
    expect(JSON.parse(stored.get('swarm-id:pending-operations') ?? '[]')).toEqual([purchase])
  })

  // The WRITE side, not the load path — the journal singleton parses storage
  // at module import, long before this seeds anything. What is pinned here is
  // that `record` rewrites storage from the validated in-memory list, so a
  // malformed neighbour is dropped rather than carried forward while the good
  // entry survives. Which matters because this store exists to rescue money
  // that is already spent.
  it('rewrites storage from the validated list, dropping a malformed neighbour', () => {
    stored.set(
      'swarm-id:pending-operations',
      JSON.stringify([{ kind: 'purchase', accountId: ACCOUNT }, purchase]),
    )
    operationJournal.record(purchase)
    expect(JSON.parse(stored.get('swarm-id:pending-operations') ?? '[]')).toEqual([purchase])
  })
})

describe('nullJournal', () => {
  it('records nothing and finds nothing', () => {
    const journal = nullJournal()
    journal.record(purchase)
    expect(journal.find(ACCOUNT, BATCH)).toBeUndefined()
    expect(journal.entries()).toEqual([])
  })
})

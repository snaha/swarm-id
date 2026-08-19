// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * What this device was in the middle of paying for.
 *
 * Chain truth answers nearly every resume question on its own — a batch either
 * has the larger depth or it does not, and residual balances are detected and
 * consumed on the next attempt. One question it cannot answer is which batch a
 * purchase created: the read-back that records it can fail, the batch is on
 * chain and owned by the account's signer, and nothing looks batches up by
 * owner. An id nobody wrote down is money spent on a drive that cannot be
 * found again.
 *
 * Written BEFORE the spend it describes and cleared only once the operation is
 * recorded, so the window it covers is exactly the one where money is at risk.
 *
 * Device-local on purpose: it records what *this* browser started, and a
 * half-finished operation is a device event, not account state. It is
 * therefore deliberately NOT synced — an entry that outlived its device would
 * be an invitation to resume something another device already finished.
 */
import { browser } from '$app/environment'

const STORAGE_KEY = 'swarm-id:pending-operations'

/** A drive this device bought and has not yet seen recorded. */
export interface PendingOperation {
  kind: 'purchase'
  accountId: string
  batchId: string
  /** The name the drive was bought under, lost otherwise. */
  name: string
  startedAt: number
}

/** The seam the runners write through, so tests need no browser storage. */
export interface OperationJournal {
  entries(): PendingOperation[]
  /** The entry for one batch, if this device has an unfinished spend on it. */
  find(accountId: string, batchId: string): PendingOperation | undefined
  /** Record or replace the entry for a batch. */
  record(entry: PendingOperation): void
  /** Drop the entry: the operation is recorded, or was abandoned deliberately. */
  clear(accountId: string, batchId: string): void
}

function isPendingOperation(value: unknown): value is PendingOperation {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const entry = value as Record<string, unknown>
  if (
    typeof entry.accountId !== 'string' ||
    typeof entry.batchId !== 'string' ||
    typeof entry.startedAt !== 'number'
  ) {
    return false
  }
  return entry.kind === 'purchase' && typeof entry.name === 'string'
}

function load(): PendingOperation[] {
  if (!browser) {
    return []
  }
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    // A malformed entry is dropped rather than throwing: this store exists to
    // rescue a stuck operation, and refusing to load would strand every other
    // entry with it.
    return Array.isArray(raw) ? raw.filter(isPendingOperation) : []
  } catch {
    return []
  }
}

function withOperationJournal() {
  let entries = $state<PendingOperation[]>(load())

  function persist() {
    if (!browser) {
      return
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    } catch {
      // Storage disabled or full. The in-memory entry still guides this
      // session, and losing the ability to resume later is a far better
      // outcome than throwing in the middle of a payment.
    }
  }

  return {
    entries: () => entries,
    find: (accountId: string, batchId: string) =>
      entries.find((entry) => entry.accountId === accountId && entry.batchId === batchId),
    record(entry: PendingOperation) {
      entries = [
        ...entries.filter(
          (existing) =>
            existing.accountId !== entry.accountId || existing.batchId !== entry.batchId,
        ),
        entry,
      ]
      persist()
    },
    clear(accountId: string, batchId: string) {
      entries = entries.filter(
        (entry) => entry.accountId !== accountId || entry.batchId !== batchId,
      )
      persist()
    },
  }
}

export const operationJournal = withOperationJournal()

/** A journal that forgets: for callers with nothing to resume, and for tests. */
export function nullJournal(): OperationJournal {
  return {
    entries: () => [],
    find: () => undefined,
    record: () => {},
    clear: () => {},
  }
}

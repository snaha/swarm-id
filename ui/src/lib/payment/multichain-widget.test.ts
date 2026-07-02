// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'

import { parseBatchEvent } from './multichain-widget'

const BATCH_ID = 'ab'.repeat(32)

/** A canonical widget `batch` message; override fields per test. */
function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'batch',
    batchId: BATCH_ID,
    depth: 21,
    amount: '10453363201',
    blockNumber: '0x2a828b8',
    ...overrides,
  }
}

describe('parseBatchEvent', () => {
  it('parses a structured-clone object payload', () => {
    expect(parseBatchEvent(makeEvent())).toEqual({
      event: 'batch',
      batchId: BATCH_ID,
      depth: 21,
      amount: '10453363201',
      blockNumber: '0x2a828b8',
    })
  })

  it('parses a JSON-string payload', () => {
    expect(parseBatchEvent(JSON.stringify(makeEvent()))?.batchId).toBe(BATCH_ID)
  })

  it('strips a 0x prefix from the batch id', () => {
    expect(parseBatchEvent(makeEvent({ batchId: `0x${BATCH_ID}` }))?.batchId).toBe(BATCH_ID)
  })

  it('coerces numeric fields arriving as strings or numbers', () => {
    const parsed = parseBatchEvent(makeEvent({ depth: '21', amount: 10453363201, blockNumber: 42 }))
    expect(parsed?.depth).toBe(21)
    expect(parsed?.amount).toBe('10453363201')
    expect(parsed?.blockNumber).toBe('42')
  })

  it('coerces a bigint amount to its string form', () => {
    expect(parseBatchEvent(makeEvent({ amount: 10453363201n }))?.amount).toBe('10453363201')
  })

  it('rejects non-batch events and non-object payloads', () => {
    expect(parseBatchEvent(makeEvent({ event: 'finish' }))).toBeUndefined()
    expect(parseBatchEvent('not json')).toBeUndefined()
    expect(parseBatchEvent(undefined)).toBeUndefined()
    expect(parseBatchEvent(42)).toBeUndefined()
  })

  it('rejects a payload with missing or non-finite fields', () => {
    expect(parseBatchEvent(makeEvent({ depth: undefined }))).toBeUndefined()
    expect(parseBatchEvent(makeEvent({ depth: 'not-a-number' }))).toBeUndefined()
    expect(parseBatchEvent(makeEvent({ amount: '' }))).toBeUndefined()
    expect(parseBatchEvent(makeEvent({ blockNumber: undefined }))).toBeUndefined()
  })

  it('rejects a malformed batch id', () => {
    expect(parseBatchEvent(makeEvent({ batchId: 'ab'.repeat(31) }))).toBeUndefined()
    expect(parseBatchEvent(makeEvent({ batchId: 'zz'.repeat(32) }))).toBeUndefined()
    expect(parseBatchEvent(makeEvent({ batchId: 1234 }))).toBeUndefined()
  })
})

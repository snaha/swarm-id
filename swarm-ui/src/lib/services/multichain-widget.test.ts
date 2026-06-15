// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest'
import { parseBatchEvent } from './multichain-widget'

const BATCH_ID = 'ab'.repeat(32) // 64 hex chars

describe('parseBatchEvent', () => {
  it('parses a well-formed object payload and strips the 0x prefix', () => {
    const event = parseBatchEvent({
      event: 'batch',
      batchId: `0x${BATCH_ID}`,
      depth: 21,
      amount: '10453363201',
      blockNumber: '0x2a828b8',
    })
    expect(event).toEqual({
      event: 'batch',
      batchId: BATCH_ID,
      depth: 21,
      amount: '10453363201',
      blockNumber: '0x2a828b8',
    })
  })

  it('accepts a batchId without the 0x prefix', () => {
    expect(
      parseBatchEvent({
        event: 'batch',
        batchId: BATCH_ID,
        depth: 21,
        amount: '1',
        blockNumber: '0x1',
      })?.batchId,
    ).toBe(BATCH_ID)
  })

  it('parses a JSON-string payload (not just structured-clone objects)', () => {
    const event = parseBatchEvent(
      JSON.stringify({
        event: 'batch',
        batchId: BATCH_ID,
        depth: 20,
        amount: '500',
        blockNumber: '0x10',
      }),
    )
    expect(event?.depth).toBe(20)
    expect(event?.amount).toBe('500')
  })

  it('coerces numeric fields that arrive as the "wrong" type', () => {
    const event = parseBatchEvent({
      event: 'batch',
      batchId: BATCH_ID,
      depth: '21', // string instead of number
      amount: 10453363201, // number instead of string
      blockNumber: 44475576, // number instead of hex string
    })
    expect(event).toEqual({
      event: 'batch',
      batchId: BATCH_ID,
      depth: 21,
      amount: '10453363201',
      blockNumber: '44475576',
    })
  })

  it('returns undefined for a non-batch event', () => {
    expect(parseBatchEvent({ event: 'finish' })).toBeUndefined()
    expect(parseBatchEvent({ event: 'error', message: 'boom' })).toBeUndefined()
  })

  it('returns undefined for an invalid batchId', () => {
    expect(
      parseBatchEvent({
        event: 'batch',
        batchId: 'not-hex',
        depth: 21,
        amount: '1',
        blockNumber: '0x1',
      }),
    ).toBeUndefined()
    // Wrong length (63 chars)
    expect(
      parseBatchEvent({
        event: 'batch',
        batchId: 'a'.repeat(63),
        depth: 21,
        amount: '1',
        blockNumber: '0x1',
      }),
    ).toBeUndefined()
  })

  it('returns undefined when a numeric field is unparseable', () => {
    expect(
      parseBatchEvent({
        event: 'batch',
        batchId: BATCH_ID,
        depth: 'NaN',
        amount: '1',
        blockNumber: '0x1',
      }),
    ).toBeUndefined()
  })

  it('returns undefined for non-object / non-JSON payloads', () => {
    expect(parseBatchEvent(undefined)).toBeUndefined()
    expect(parseBatchEvent(null)).toBeUndefined()
    expect(parseBatchEvent(42)).toBeUndefined()
    expect(parseBatchEvent('not json')).toBeUndefined()
    expect(parseBatchEvent('"a string"')).toBeUndefined()
  })
})

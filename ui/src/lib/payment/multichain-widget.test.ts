// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type PurchaseStampOptions,
  type StampPurchaseHandle,
  openStampPurchaseWidget,
  parseBatchEvent,
} from './multichain-widget'

const BATCH_ID = 'ab'.repeat(32)
const DESTINATION = '0x45a1502382541Cd610CC9068e88727426b696293'
const WIDGET_ORIGIN = 'https://swarmbucks.eth.limo'
// Mirrors the widget's own timers; kept in step by the fake-timer advances below.
const CLOSE_POLL_MS = 500
const CLOSE_GRACE_MS = 1_500
/** The widget's first `payment` event — the point of no return. */
const PAYMENT_SENT = { event: 'payment', phase: 'sent', chainId: 1, resumed: false }

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

describe('openStampPurchaseWidget', () => {
  let popup: { closed: boolean; close: ReturnType<typeof vi.fn> }
  let listener: ((event: unknown) => void) | undefined
  let callbacks: ReturnType<typeof makeCallbacks>

  /** Fresh spies for the four outcome callbacks, typed from the real options. */
  function makeCallbacks() {
    return {
      onSuccess: vi.fn<PurchaseStampOptions['onSuccess']>(),
      onError: vi.fn<PurchaseStampOptions['onError']>(),
      onCancel: vi.fn<PurchaseStampOptions['onCancel']>(),
      onUnconfirmedClose: vi.fn<PurchaseStampOptions['onUnconfirmedClose']>(),
    }
  }

  /** Open the widget against a stubbed `window`, capturing its message listener. */
  function open(): StampPurchaseHandle {
    return openStampPurchaseWidget({ destination: DESTINATION, ...callbacks })
  }

  /** Deliver a message as if the popup had posted it. */
  function post(data: unknown, from: unknown = popup, origin = WIDGET_ORIGIN): void {
    listener?.({ source: from, origin, data })
  }

  /** The user (or the widget) closes the popup; run out the grace window. */
  function closePopup(): void {
    popup.closed = true
    vi.advanceTimersByTime(CLOSE_POLL_MS + CLOSE_GRACE_MS)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    popup = { closed: false, close: vi.fn() }
    listener = undefined
    callbacks = makeCallbacks()
    // The service only ever touches these three, and reads only
    // source/origin/data off an event — enough to test without a DOM.
    vi.stubGlobal('window', {
      open: () => popup,
      addEventListener: (_type: string, fn: (event: unknown) => void) => (listener = fn),
      // Actually drops the listener. A no-op here lets `post()` keep delivering
      // after `cleanup()`, so any test about what happens once the service has
      // detached would pass while exercising a listener the real code removed.
      removeEventListener: (_type: string, fn: (event: unknown) => void) => {
        if (listener === fn) listener = undefined
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('records a batch and leaves the popup running for the trailing sweep', () => {
    open()
    post(makeEvent())
    expect(callbacks.onSuccess).toHaveBeenCalledWith(expect.objectContaining({ batchId: BATCH_ID }))
    expect(popup.close).not.toHaveBeenCalled()
  })

  it('closes the popup on `finish` after a batch, without a second callback', () => {
    open()
    post(makeEvent())
    post({ event: 'finish' })
    expect(popup.close).toHaveBeenCalled()
    expect(callbacks.onCancel).not.toHaveBeenCalled()
    expect(callbacks.onUnconfirmedClose).not.toHaveBeenCalled()
  })

  it('treats a `finish` with nothing paid as a clean cancel', () => {
    open()
    post({ event: 'finish' })
    expect(callbacks.onCancel).toHaveBeenCalled()
    expect(callbacks.onUnconfirmedClose).not.toHaveBeenCalled()
  })

  it('treats a `finish` after a payment but without a batch as unconfirmed', () => {
    open()
    post(PAYMENT_SENT)
    post({ event: 'finish' })
    expect(callbacks.onUnconfirmedClose).toHaveBeenCalled()
    expect(callbacks.onCancel).not.toHaveBeenCalled()
  })

  it('treats a popup close with nothing paid as a clean cancel', () => {
    open()
    closePopup()
    expect(callbacks.onCancel).toHaveBeenCalled()
    expect(callbacks.onUnconfirmedClose).not.toHaveBeenCalled()
  })

  it('treats a popup close after a payment as unconfirmed', () => {
    open()
    post(PAYMENT_SENT)
    closePopup()
    expect(callbacks.onUnconfirmedClose).toHaveBeenCalled()
    expect(callbacks.onCancel).not.toHaveBeenCalled()
  })

  it('says nothing when the popup closes after the batch was recorded', () => {
    open()
    post(makeEvent())
    closePopup()
    expect(callbacks.onCancel).not.toHaveBeenCalled()
    expect(callbacks.onUnconfirmedClose).not.toHaveBeenCalled()
  })

  it('still records a batch arriving in the grace window after the close', () => {
    open()
    popup.closed = true
    vi.advanceTimersByTime(CLOSE_POLL_MS)
    post(makeEvent())
    vi.advanceTimersByTime(CLOSE_GRACE_MS)
    expect(callbacks.onSuccess).toHaveBeenCalled()
    expect(callbacks.onCancel).not.toHaveBeenCalled()
  })

  it('reports an `error` event and closes the popup', () => {
    open()
    post({ event: 'error', message: 'Swap failed' })
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Swap failed' }),
    )
    expect(popup.close).toHaveBeenCalled()
  })

  // What the deployed build actually posts (`{event: 'error', error: <err>}`).
  // Reading only `message` turned every real widget failure into the generic
  // "Widget error", which is the one string a user can do nothing with.
  it('reports the error the widget actually sends', () => {
    open()
    post({ event: 'error', error: 'Insufficient balance for the swap' })
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Insufficient balance for the swap' }),
    )
  })

  it('unwraps an Error object posted by the widget', () => {
    open()
    post({ event: 'error', error: new Error('Swap reverted') })
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Swap reverted' }),
    )
  })

  // The same rule `cancel()` and `finish` follow: a popup holding the user's
  // money on the temporary wallet is never forced shut — its pipeline runs
  // client-side, so killing it strands the funds (#550). The widget can also
  // recover in-popup (its `payment` events carry a `resumed` flag), so the
  // listener stays attached: a batch that recovery settles must still land.
  it('leaves an errored popup open once money is in flight', () => {
    open()
    post(PAYMENT_SENT)
    post({ event: 'error', error: 'Swap failed' })
    expect(callbacks.onError).toHaveBeenCalled()
    expect(popup.close).not.toHaveBeenCalled()
  })

  it('still records a batch the widget settles after an error', () => {
    open()
    post(PAYMENT_SENT)
    post({ event: 'error', error: 'Swap failed' })
    post(makeEvent())
    expect(callbacks.onSuccess).toHaveBeenCalledWith(expect.objectContaining({ batchId: BATCH_ID }))
  })

  it('cancel() closes the popup before any payment', () => {
    const handle = open()
    handle.cancel()
    expect(popup.close).toHaveBeenCalled()
  })

  it('cancel() leaves the popup open once money is in flight', () => {
    const handle = open()
    post(PAYMENT_SENT)
    handle.cancel()
    expect(popup.close).not.toHaveBeenCalled()
  })

  // Cancelling after a payment is the one exit that tells the user nothing: no
  // callback fires (they asked for it), and the popup keeps running with their
  // money in it. `cancel()` reports that, so the caller can say so.
  it('cancel() reports whether the popup was left running with money in it', () => {
    const clean = open()
    expect(clean.cancel()).toBe(false)

    callbacks = makeCallbacks()
    const paid = open()
    post(PAYMENT_SENT)
    expect(paid.cancel()).toBe(true)
    // Terminal either way: a second cancel (the dialog's `onDestroy` after its
    // own `close()`) must not toast twice.
    expect(paid.cancel()).toBe(false)
  })

  it('cancel() leaves the popup open once a batch settled, so the sweep finishes', () => {
    const handle = open()
    post(makeEvent())
    handle.cancel()
    expect(popup.close).not.toHaveBeenCalled()
  })

  it('ignores messages from a foreign origin or a foreign source', () => {
    open()
    post(makeEvent(), popup, 'https://evil.example')
    post(makeEvent(), { closed: false })
    expect(callbacks.onSuccess).not.toHaveBeenCalled()
  })
})

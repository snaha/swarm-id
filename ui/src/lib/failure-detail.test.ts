// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'

import { failureDetail } from './failure-detail'

/** A Firefox/Safari stack: frames only, no message line. Chrome's has one. */
const GECKO_STACK = 'b@https://swarm-id.snaha.net/_app/immutable/chunks/DKDmvjIk.js:3:10302'

describe('failureDetail', () => {
  // The bug this exists for: the panel showed the stack, and outside V8 a
  // stack has no message in it, so the reader got a minified frame and
  // nothing else.
  it('reports the message where the stack has none', () => {
    const error = new Error('The purchase transaction was not confirmed in time.')
    error.name = 'TimeoutError'
    error.stack = GECKO_STACK

    const detail = failureDetail(error)
    expect(detail).toContain('The purchase transaction was not confirmed in time.')
    expect(detail).toContain('TimeoutError')
    expect(detail).not.toContain('DKDmvjIk')
  })

  it('walks the cause chain, which is where the diagnosis lives', () => {
    const timeout = new Error('The purchase transaction was not confirmed in time.')
    timeout.name = 'TimeoutError'
    const pending = new Error('Your purchase was sent but not confirmed in time.', {
      cause: timeout,
    })
    pending.name = 'CreatePendingError'

    expect(failureDetail(pending)).toBe(
      'CreatePendingError: Your purchase was sent but not confirmed in time.\n' +
        'caused by TimeoutError: The purchase transaction was not confirmed in time.',
    )
  })

  // The widget hands us its own payload as the cause; `[object Object]` would
  // throw away the only thing the popup told us.
  it('renders a non-Error cause readably', () => {
    const detail = failureDetail(
      new Error('The payment failed.', { cause: { event: 'error', code: 'INSUFFICIENT_FUNDS' } }),
    )
    expect(detail).toContain('INSUFFICIENT_FUNDS')
    expect(detail).not.toContain('[object Object]')
  })

  it('survives a cause that loops', () => {
    const outer = new Error('outer')
    const inner = new Error('inner', { cause: outer })
    ;(outer as { cause?: unknown }).cause = inner

    expect(failureDetail(outer)).toBe('Error: outer\ncaused by Error: inner')
  })

  it('survives a cause that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(() => failureDetail(new Error('boom', { cause: cyclic }))).not.toThrow()
  })

  // Nothing to add over the message the dialog already shows, so the caller
  // hides "View details" rather than revealing the same sentence twice.
  it('is empty for a plain error with no cause', () => {
    expect(failureDetail(new Error('Could not buy the drive.'))).toBe('')
  })

  it('keeps a named error even with no cause, because the name is the finding', () => {
    const error = new Error('It did not finish.')
    error.name = 'SizeIncreasePendingError'
    expect(failureDetail(error)).toBe('SizeIncreasePendingError: It did not finish.')
  })

  it('describes a non-Error throw', () => {
    expect(failureDetail('just a string')).toBe('just a string')
    expect(failureDetail({ code: 42 })).toBe('{"code":42}')
    expect(failureDetail(undefined)).toBe('undefined')
  })
})

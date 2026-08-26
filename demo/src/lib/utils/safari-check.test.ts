// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The verdicts are the deliverable of #584: the device they run on has no
 * console (Safari on iOS needs a Mac and a cable), so a wrong verdict is not
 * something the tester can go behind and check.
 */
import { describe, expect, it } from 'vitest'

import { formatReport, runChecks } from './safari-check'
import type { CheckInput, CheckResult } from './safari-check'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OTHER_DEVICE = '11111111-2222-3333-4444-555555555555'

function verdictOf(results: CheckResult[], id: string): string {
  const found = results.find((result) => result.id === id)
  if (!found) throw new Error(`no check with id ${id}`)
  return found.verdict
}

function connected(overrides: Partial<NonNullable<CheckInput['connection']>> = {}) {
  return {
    canUpload: true,
    storagePartitioned: true,
    uploadMode: 'user-stamp' as const,
    deviceId: DEVICE,
    ...overrides,
  }
}

describe('runChecks', () => {
  it('reports nothing as known before a connection', () => {
    const results = runChecks({ loadsSinceFirstSeen: 0 })
    for (const result of results) expect(result.verdict).toBe('unknown')
  })

  // A run where nothing partitioned says nothing about ITP — reporting the
  // handover as a pass there would be the test lying to us.
  it('does not credit the handover when storage was never partitioned', () => {
    const results = runChecks({
      connection: connected({ storagePartitioned: false }),
      loadsSinceFirstSeen: 0,
    })
    expect(verdictOf(results, 'partitioned')).toBe('fail')
    expect(verdictOf(results, 'handover')).toBe('unknown')
  })

  // On the partitioned path the only way to hold a stamp is the popup's
  // postMessage having reached the iframe through `window.opener`.
  it('credits the handover when a partitioned session holds its own stamp', () => {
    const results = runChecks({ connection: connected(), loadsSinceFirstSeen: 0 })
    expect(verdictOf(results, 'handover')).toBe('pass')
  })

  it('fails the handover when a partitioned session cannot write', () => {
    const results = runChecks({
      connection: connected({ uploadMode: 'unavailable', canUpload: false }),
      loadsSinceFirstSeen: 0,
    })
    expect(verdictOf(results, 'handover')).toBe('fail')
  })

  it('cannot judge persistence on the first load', () => {
    const results = runChecks({ connection: connected(), loadsSinceFirstSeen: 0 })
    expect(verdictOf(results, 'persistence')).toBe('unknown')
  })

  it('passes persistence when the device id is unchanged', () => {
    const results = runChecks({
      connection: connected(),
      previousDeviceId: DEVICE,
      loadsSinceFirstSeen: 3,
    })
    expect(verdictOf(results, 'persistence')).toBe('pass')
  })

  // The finding #570 is waiting on: a new id means the partitioned storage was
  // evicted and the roster gained another device.
  it('fails persistence when the device id changed', () => {
    const results = runChecks({
      connection: connected(),
      previousDeviceId: OTHER_DEVICE,
      loadsSinceFirstSeen: 1,
    })
    const persistence = results.find((result) => result.id === 'persistence')!
    expect(persistence.verdict).toBe('fail')
    expect(persistence.detail).toContain('evicted')
  })

  it('reports the upload round trip only once attempted', () => {
    expect(
      verdictOf(runChecks({ connection: connected(), loadsSinceFirstSeen: 0 }), 'upload'),
    ).toBe('unknown')
    expect(
      verdictOf(
        runChecks({ connection: connected(), loadsSinceFirstSeen: 0, uploadRoundTrip: 'ok' }),
        'upload',
      ),
    ).toBe('pass')
    expect(
      verdictOf(
        runChecks({ connection: connected(), loadsSinceFirstSeen: 0, uploadRoundTrip: 'failed' }),
        'upload',
      ),
    ).toBe('fail')
  })
})

describe('formatReport', () => {
  // The tester pastes this back; it has to carry the verdicts AND the device
  // it ran on, or a result cannot be attributed to an iOS version.
  it('renders every verdict and the environment', () => {
    const report = formatReport(runChecks({ connection: connected(), loadsSinceFirstSeen: 0 }), {
      userAgent: 'iPhone',
      idOrigin: 'https://swarm-id.snaha.net',
    })
    expect(report).toContain('iPhone')
    expect(report).toContain('https://swarm-id.snaha.net')
    expect(report).toContain('[PASS] window.opener handover survived')
    expect(report).toContain('[????] Partitioned storage survives reloads')
  })
})

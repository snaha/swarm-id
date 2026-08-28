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
    storagePartitioned: true,
    uploadMode: 'user-stamp' as const,
    deviceId: DEVICE,
    ...overrides,
  }
}

describe('runChecks', () => {
  it('reports nothing as known before a connection', () => {
    const results = runChecks({ loadCount: 0 })
    for (const result of results) expect(result.verdict).toBe('unknown')
  })

  // A run where nothing partitioned says nothing about ITP — reporting the
  // handover as a pass there would be the test lying to us.
  it('does not credit the handover when storage was never partitioned', () => {
    const results = runChecks({
      connection: connected({ storagePartitioned: false }),
      loadCount: 0,
    })
    expect(verdictOf(results, 'partitioned')).toBe('fail')
    expect(verdictOf(results, 'handover')).toBe('unknown')
  })

  // The proxy sets `storagePartitioned` in exactly one place — the `setSecret`
  // handler — so a partitioned session that is authenticated at all got there
  // through `window.opener`.
  it('credits the handover on a partitioned session, whatever it can write', () => {
    expect(verdictOf(runChecks({ connection: connected(), loadCount: 0 }), 'handover')).toBe('pass')
    expect(
      verdictOf(
        runChecks({
          connection: connected({ uploadMode: 'unavailable', uploadUnavailableReason: 'no-stamp' }),
          loadCount: 0,
        }),
        'handover',
      ),
    ).toBe('pass')
  })

  // The run that made this split necessary: an iPhone connected an account
  // created fresh in the popup, and the harness reported the missing drive as a
  // failed `window.opener` handover — a claim about ITP, from a run that never
  // reached the writer path at all.
  it('replays the first device report: handover passed, the writer was never exercised', () => {
    const results = runChecks({
      connection: {
        storagePartitioned: true,
        uploadMode: 'unavailable',
        uploadUnavailableReason: 'no-stamp',
        deviceId: '7dc3690a-bd74-4b0f-8667-dd94a40a4e4f',
      },
      loadCount: 1,
    })
    expect(verdictOf(results, 'partitioned')).toBe('pass')
    expect(verdictOf(results, 'handover')).toBe('pass')
    expect(verdictOf(results, 'writer')).toBe('unknown')
    expect(results.find((result) => result.id === 'writer')?.detail).toContain('no drive')
    // Nothing here is a failure — the run is incomplete, not negative.
    expect(results.some((result) => result.verdict === 'fail')).toBe(false)
  })

  it('credits the writer when a partitioned session holds its own stamp', () => {
    const results = runChecks({ connection: connected(), loadCount: 0 })
    expect(verdictOf(results, 'writer')).toBe('pass')
  })

  // Ours to fix, unlike a missing drive — so these are the two that go red.
  it.each(['download-only', 'stamper-failed'] as const)(
    'fails the writer when the reason is %s',
    (uploadUnavailableReason) => {
      const results = runChecks({
        connection: connected({ uploadMode: 'unavailable', uploadUnavailableReason }),
        loadCount: 0,
      })
      expect(verdictOf(results, 'writer')).toBe('fail')
      expect(verdictOf(results, 'handover')).toBe('pass')
    },
  )

  // Uploads work, but through the dApp's gateway rather than the account's own
  // stamp — so it says nothing about the handed-over write path either way.
  it('does not judge the writer when uploads run on a subsidised gateway', () => {
    const results = runChecks({
      connection: connected({ uploadMode: 'subsidised' }),
      loadCount: 0,
    })
    expect(verdictOf(results, 'writer')).toBe('unknown')
  })

  it('carries the upload error into the verdict, since the device has no console', () => {
    const results = runChecks({
      connection: connected(),
      loadCount: 1,
      uploadRoundTrip: 'failed',
      uploadError: 'invalid batch id',
    })
    expect(verdictOf(results, 'upload')).toBe('fail')
    expect(results.find((result) => result.id === 'upload')?.detail).toContain('invalid batch id')
  })

  it('cannot judge persistence on the first load', () => {
    const results = runChecks({ connection: connected(), loadCount: 0 })
    expect(verdictOf(results, 'persistence')).toBe('unknown')
  })

  it('passes persistence when the device id is unchanged', () => {
    const results = runChecks({
      connection: connected(),
      previousDeviceId: DEVICE,
      loadCount: 3,
    })
    expect(verdictOf(results, 'persistence')).toBe('pass')
  })

  // The finding #570 is waiting on: a new id means the partitioned storage was
  // evicted and the roster gained another device.
  it('fails persistence when the device id changed', () => {
    const results = runChecks({
      connection: connected(),
      previousDeviceId: OTHER_DEVICE,
      loadCount: 1,
    })
    const persistence = results.find((result) => result.id === 'persistence')!
    expect(persistence.verdict).toBe('fail')
    expect(persistence.detail).toContain('evicted')
  })

  it('reports the upload round trip only once attempted', () => {
    expect(verdictOf(runChecks({ connection: connected(), loadCount: 0 }), 'upload')).toBe(
      'unknown',
    )
    expect(
      verdictOf(
        runChecks({ connection: connected(), loadCount: 0, uploadRoundTrip: 'ok' }),
        'upload',
      ),
    ).toBe('pass')
    expect(
      verdictOf(
        runChecks({ connection: connected(), loadCount: 0, uploadRoundTrip: 'failed' }),
        'upload',
      ),
    ).toBe('fail')
  })
})

describe('formatReport', () => {
  // The tester pastes this back; it has to carry the verdicts AND the device
  // it ran on, or a result cannot be attributed to an iOS version.
  it('renders every verdict and the environment', () => {
    const report = formatReport(runChecks({ connection: connected(), loadCount: 0 }), {
      userAgent: 'iPhone',
      idOrigin: 'https://swarm-id.snaha.net',
    })
    expect(report).toContain('iPhone')
    expect(report).toContain('https://swarm-id.snaha.net')
    expect(report).toContain('[PASS] window.opener handover survived')
    expect(report).toContain('[????] Partitioned storage survives reloads')
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Verdicts for the real-Safari smoke test (#584).
 *
 * The storage-partitioning write path is confirmed on Chromium and Firefox with
 * third-party storage partitioned; it has never run on actual iOS Safari, so
 * the headline claim rests on an emulation of WebKit's behaviour rather than
 * WebKit. Three questions only a real device answers, and none of them can be
 * read off a console — Safari on iOS has no inspector without a Mac and a
 * cable — so the page has to reach its own verdicts and show them.
 *
 * The logic lives here, apart from the page, because it is the part worth
 * testing: a wrong verdict on a device we cannot debug is worse than no verdict.
 */

/** What the page has observed, across this load and the previous one. */
export interface CheckInput {
  /** ConnectionInfo as last reported by the proxy. */
  connection?: {
    storagePartitioned?: boolean
    uploadMode?: 'user-stamp' | 'subsidised' | 'unavailable'
    deviceId?: string
  }
  /** The device id this page recorded on an earlier load, if any. */
  previousDeviceId?: string
  /** Page loads this page has counted since the last reset, including this one. */
  loadCount: number
  /** Whether an upload attempt in this session round-tripped. */
  uploadRoundTrip?: 'ok' | 'failed'
}

export type Verdict = 'pass' | 'fail' | 'unknown'

export interface CheckResult {
  id: string
  title: string
  verdict: Verdict
  detail: string
}

/**
 * Whether the browser partitioned the iframe's storage at all. Not itself a
 * pass/fail of the feature — it decides which of the other answers mean
 * anything. A run where nothing partitioned tells us nothing about ITP.
 */
function partitioning(input: CheckInput): CheckResult {
  const partitioned = input.connection?.storagePartitioned
  if (input.connection === undefined) {
    return {
      id: 'partitioned',
      title: 'Storage is partitioned',
      verdict: 'unknown',
      detail: 'Not connected yet — connect first.',
    }
  }
  return partitioned
    ? {
        id: 'partitioned',
        title: 'Storage is partitioned',
        verdict: 'pass',
        detail: 'The iframe cannot see the identity origin’s first-party storage — ITP is on.',
      }
    : {
        id: 'partitioned',
        title: 'Storage is partitioned',
        verdict: 'fail',
        detail:
          'Storage was NOT partitioned, so this run says nothing about ITP. Check the two sites really are cross-site.',
      }
}

/**
 * The popup handover: on the partitioned path the ONLY way the session becomes
 * a writer is the connect popup's `setSecret` reaching the iframe through
 * `window.opener`. So a writing session is proof that survived ITP.
 */
function popupHandover(input: CheckInput): CheckResult {
  const connection = input.connection
  if (!connection) {
    return {
      id: 'handover',
      title: 'window.opener handover survived',
      verdict: 'unknown',
      detail: 'Not connected yet — connect first.',
    }
  }
  if (!connection.storagePartitioned) {
    return {
      id: 'handover',
      title: 'window.opener handover survived',
      verdict: 'unknown',
      detail: 'Storage was not partitioned, so the handover was never the path under test.',
    }
  }
  return connection.uploadMode === 'user-stamp'
    ? {
        id: 'handover',
        title: 'window.opener handover survived',
        verdict: 'pass',
        detail: 'Partitioned AND holding its own stamp — the popup’s postMessage landed.',
      }
    : {
        id: 'handover',
        title: 'window.opener handover survived',
        verdict: 'fail',
        detail: `Partitioned but upload mode is "${connection.uploadMode ?? 'unknown'}" — the handover did not land.`,
      }
}

/**
 * Whether the partitioned storage holding the device id survived. A NEW id on a
 * later load means it was evicted, and every session joins the device roster as
 * a new device (#570) — the growth problem this test exists to measure.
 */
function storagePersistence(input: CheckInput): CheckResult {
  const current = input.connection?.deviceId
  if (!current) {
    return {
      id: 'persistence',
      title: 'Partitioned storage survives reloads',
      verdict: 'unknown',
      detail: 'No device id reported yet — connect first.',
    }
  }
  if (!input.previousDeviceId) {
    return {
      id: 'persistence',
      title: 'Partitioned storage survives reloads',
      verdict: 'unknown',
      detail: `First load — recorded ${current.slice(0, 8)}…. Reload (and come back tomorrow) to compare.`,
    }
  }
  return current === input.previousDeviceId
    ? {
        id: 'persistence',
        title: 'Partitioned storage survives reloads',
        verdict: 'pass',
        detail: `Same device id across ${input.loadCount} load(s): ${current.slice(0, 8)}….`,
      }
    : {
        id: 'persistence',
        title: 'Partitioned storage survives reloads',
        verdict: 'fail',
        detail: `Device id CHANGED (${input.previousDeviceId.slice(0, 8)}… → ${current.slice(0, 8)}…) — the partitioned storage was evicted, so this session is a new device in the roster.`,
      }
}

/** Whether the session can actually put bytes on Swarm and read them back. */
function uploadPath(input: CheckInput): CheckResult {
  if (!input.uploadRoundTrip) {
    return {
      id: 'upload',
      title: 'Upload round-trips',
      verdict: 'unknown',
      detail: 'Not attempted yet.',
    }
  }
  return input.uploadRoundTrip === 'ok'
    ? {
        id: 'upload',
        title: 'Upload round-trips',
        verdict: 'pass',
        detail: 'Uploaded and read back byte-identical.',
      }
    : {
        id: 'upload',
        title: 'Upload round-trips',
        verdict: 'fail',
        detail: 'The upload or the read-back failed — see the log below.',
      }
}

export function runChecks(input: CheckInput): CheckResult[] {
  return [partitioning(input), popupHandover(input), storagePersistence(input), uploadPath(input)]
}

/** A paste-able summary — the device has no console to copy from. */
export function formatReport(results: CheckResult[], environment: Record<string, string>): string {
  const lines = ['# Safari partitioned-upload check (#584)', '']
  for (const [key, value] of Object.entries(environment)) {
    lines.push(`${key}: ${value}`)
  }
  lines.push('')
  for (const result of results) {
    const mark = result.verdict === 'pass' ? 'PASS' : result.verdict === 'fail' ? 'FAIL' : '????'
    lines.push(`[${mark}] ${result.title}`)
    lines.push(`       ${result.detail}`)
  }
  return lines.join('\n')
}

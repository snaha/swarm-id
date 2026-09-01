// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Verdicts for the real-Safari smoke test (#584).
 *
 * Questions only a real device answers, none of which can be read off a console
 * — Safari on iOS has no inspector without a Mac and a cable — so the page has
 * to reach its own verdicts and show them.
 *
 * The logic lives here, apart from the page, because it is the part worth
 * testing: a wrong verdict on a device we cannot debug is worse than no
 * verdict. The first run proved that the hard way — it reported a failed
 * `window.opener` handover, a claim about ITP, for an account that simply had
 * no drive. **The handover and the writer are separate questions**, and this
 * file keeps them separate: `storagePartitioned` is set in exactly one place in
 * the proxy (the `setSecret` handler), so a partitioned session reporting it is
 * proof the popup's postMessage arrived, whatever happens downstream.
 */
import type { UploadUnavailableReason } from '@snaha/swarm-id'

/** What the page has observed, across this load and the previous one. */
export interface CheckInput {
  /** ConnectionInfo as last reported by the proxy. */
  connection?: {
    storagePartitioned?: boolean
    uploadMode?: 'user-stamp' | 'subsidised' | 'unavailable'
    uploadUnavailableReason?: UploadUnavailableReason
    deviceId?: string
  }
  /** The device id this page recorded on an earlier load, if any. */
  previousDeviceId?: string
  /** Page loads this page has counted since the last reset, including this one. */
  loadCount: number
  /** Whether an upload attempt in this session round-tripped. */
  uploadRoundTrip?: 'ok' | 'failed'
  /** What the upload threw, when it failed. The device has no console. */
  uploadError?: string
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
 * The popup handover, and ONLY the handover: did `setSecret` reach the iframe
 * through `window.opener` under ITP?
 *
 * `storagePartitioned` answers it on its own. The proxy sets that flag in one
 * place — the `setSecret` handler — so a partitioned session reporting it
 * cannot have got there any other way. Whether the session then became a
 * writer is a different question with different causes; see {@link writerPath}.
 */
function popupHandover(input: CheckInput): CheckResult {
  const connection = input.connection
  if (!connection) {
    return {
      id: 'handover',
      title: 'window.opener handover survived',
      verdict: 'unknown',
      // A handover that genuinely failed can only ever land here: no
      // `setSecret` means never authenticated, which means no ConnectionInfo
      // and every check grey. Say so, or an all-grey report reads as "did not
      // get round to it" when it is the failure this page is here to catch.
      detail:
        'Not connected yet — connect first. If the popup DID complete and this page still says not connected, that is what a failed handover looks like: report it as such.',
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
  return {
    id: 'handover',
    title: 'window.opener handover survived',
    verdict: 'pass',
    detail:
      'Partitioned, and the session is authenticated — only the popup’s postMessage through window.opener can do that here, so it survived ITP.',
  }
}

/**
 * Whether the handed-over session became a first-class writer.
 *
 * Split from the handover because the two failed together in the first device
 * run and only one of them had actually failed. Anything the tester can fix —
 * an account with no drive above all — is `unknown` rather than `fail`: it
 * means the writer path was never exercised, which is not the same as a broken
 * one.
 */
function writerPath(input: CheckInput): CheckResult {
  const id = 'writer'
  const title = 'Session became a writer'
  const connection = input.connection
  if (!connection) {
    return { id, title, verdict: 'unknown', detail: 'Not connected yet — connect first.' }
  }
  if (!connection.storagePartitioned) {
    return {
      id,
      title,
      verdict: 'unknown',
      detail: 'Storage was not partitioned, so this is not the path under test.',
    }
  }
  if (connection.uploadMode === 'user-stamp') {
    return {
      id,
      title,
      verdict: 'pass',
      detail: 'Holding its own stamp — the hydrated account view built a working write path.',
    }
  }
  if (connection.uploadMode === 'subsidised') {
    return {
      id,
      title,
      verdict: 'unknown',
      // The reason is only computed for `unavailable`, so a gateway configured
      // here also masks a genuine `stamper-failed`: the mode falls back to
      // `subsidised` and the failure never surfaces. Run without one.
      detail:
        'Uploading through the dApp’s subsidised gateway, not the account’s own stamp — that path bypasses the one under test, and a stamper failure would fall back to it unnoticed. Run this with no subsidised gateway configured.',
    }
  }
  switch (connection.uploadUnavailableReason) {
    case 'no-stamp':
      return {
        id,
        title,
        verdict: 'unknown',
        detail:
          'This account has no drive, so there was no stamp to hand over and the writer path was never exercised. Buy a drive on the identity site, then reconnect and run this again.',
      }
    case 'stamper-failed':
      return {
        id,
        title,
        verdict: 'fail',
        detail:
          'The stamp resolved and the stamper still would not build — the write path broke inside the partitioned iframe. This is the real failure this test exists to catch.',
      }
    default:
      // Not red: `uploadUnavailableReason` is optional on the wire, so an older
      // identity deployment sends `unavailable` without one and this branch is
      // reached by version skew, not by a broken write path. Calling that a
      // failure is exactly the misreading the split above exists to stop.
      return {
        id,
        title,
        verdict: 'unknown',
        detail: `Upload mode is "${connection.uploadMode ?? 'unknown'}" and the proxy gave no reason — most likely an identity deployment older than this page. Check the identity site's version, then run this again.`,
      }
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
        // Carried here rather than left in the log: the log is on another page,
        // the report does not include it, and the device has no inspector — so
        // "see the log below" was a reason nobody could paste back.
        detail: `The upload or the read-back failed${input.uploadError ? ` — ${input.uploadError}` : '.'}`,
      }
}

export function runChecks(input: CheckInput): CheckResult[] {
  return [
    partitioning(input),
    popupHandover(input),
    writerPath(input),
    storagePersistence(input),
    uploadPath(input),
  ]
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

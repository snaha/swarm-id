// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Time and Session Constants
 *
 * Centralized constants for time units and default session durations.
 */

// ============================================================================
// Time Units (in milliseconds)
// ============================================================================

export const SECOND = 1_000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

// ============================================================================
// Request Timing
// ============================================================================

/** How long the client waits for the proxy's answer to a request, by default */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30 * SECOND

/**
 * How often the proxy says a write waiting for its drive is still queued
 * (`requestQueued`), the first time as soon as it starts waiting.
 */
export const REQUEST_QUEUED_INTERVAL_MS = 5 * SECOND

/**
 * How long the client lets a queued write's proxy go without a beat, or the
 * request's own timeout when that is longer: a proxy that has died is caught
 * within it, whatever timeout the client was built with.
 */
export const QUEUED_SILENCE_TIMEOUT_MS = 3 * REQUEST_QUEUED_INTERVAL_MS

/**
 * The silence either side of a streaming transfer tolerates by default: the
 * client waiting on the proxy, the proxy waiting on an upload's source or a
 * download's reader. A longer `requestOptions.timeout` raises both.
 */
export const STREAM_IDLE_TIMEOUT_MS = 2 * MINUTE

/**
 * The proxy posts an upload's progress at most this often: a report per chunk
 * would be hundreds of thousands of messages for a large file, each parsed on
 * the dApp's main thread. A report held back is posted once the interval is
 * up, and the last one always is.
 */
export const PROGRESS_INTERVAL_MS = 250

// ============================================================================
// Session Defaults
// ============================================================================

export const DEFAULT_SESSION_DURATION = 30 * DAY

/**
 * How long a connection to a dApp lasts, in ms: the app's own setting when
 * the user gave it one, else the account's, else the default above.
 *
 * One rule with two callers on opposite sides of the handover — the popup
 * writes `connectedUntil` from it when it saves the connection
 * (`ui/src/lib/connect-handshake.ts`), and a partitioned proxy recomputes the
 * same deadline when it hydrates (`hydratePartitionAccount`). Two copies of
 * `?? DEFAULT_SESSION_DURATION` is one copy that goes stale when the rule
 * gains a clamp or a floor (#590).
 */
export function appSessionDuration(
  settings?: { appSessionDuration?: number },
  app?: { sessionDuration?: number },
): number {
  return (
    app?.sessionDuration ??
    settings?.appSessionDuration ??
    DEFAULT_SESSION_DURATION
  )
}

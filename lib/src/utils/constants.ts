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
 * How often, at most, the proxy says a write waiting for its drive is still
 * there (`requestAlive`). The proxy knows a call's own `requestOptions.timeout`
 * and the default above, not a client built with a shorter default of its own.
 */
export const REQUEST_ALIVE_INTERVAL_MS = 5 * SECOND

/**
 * The proxy posts an upload's progress at most this often: a report per chunk
 * would be hundreds of thousands of messages for a large file, each parsed on
 * the dApp's main thread. The last report is always posted.
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

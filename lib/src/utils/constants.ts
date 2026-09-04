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
// Session Defaults
// ============================================================================

export const DEFAULT_SESSION_DURATION = 30 * DAY

/**
 * How long a connection to a dApp lasts, in ms: the account's own setting, or
 * the default above.
 *
 * One rule with two callers on opposite sides of the handover — the popup
 * writes `connectedUntil` from it when it saves the connection
 * (`ui/src/lib/connect-handshake.ts`), and a partitioned proxy recomputes the
 * same deadline when it hydrates (`hydratePartitionAccount`). Two copies of
 * `?? DEFAULT_SESSION_DURATION` is one copy that goes stale when the rule
 * gains a clamp or a floor (#590).
 */
export function appSessionDuration(settings: {
  appSessionDuration?: number
}): number {
  return settings?.appSessionDuration ?? DEFAULT_SESSION_DURATION
}

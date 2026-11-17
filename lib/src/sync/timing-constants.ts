// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-module timing constants for the multi-device sync path.
 *
 * This module has NO imports on purpose: it is the single source of truth for
 * values several sync modules share, so it can be imported by any of them
 * (including `utils/batch-utilization`) without a circular import. Keeping the
 * values here removes the drift risk of the same literal defined independently
 * in each module.
 */

/**
 * Client-side timeout for a single cross-device SOC/feed read (roster entry,
 * state-pointer). Bee has no fast authoritative
 * "not found" — a retrieval of an absent chunk fails only after exhausting
 * peers — so an absent target would otherwise block for tens of seconds. A
 * present chunk in its neighborhood retrieves well under this; a timed-out read
 * is treated as inconclusive (see each caller's sentinel handling).
 */
export const SYNC_READ_TIMEOUT_MS = 2500

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const NOT_FOUND = 404

/**
 * True only for a definitive "chunk absent" — an HTTP 404, as Bee's `/soc`
 * endpoint returns for a missing single-owner chunk (`BeeResponseError.status`).
 * A timeout / 5xx / network error is INCONCLUSIVE, not a confirmed miss.
 *
 * NOTE: Bee's `/chunks` endpoint returns **500** ("read chunk failed") for an
 * absent chunk, so this predicate is usable for the roster `/soc` existence read
 * but NOT for the `/chunks`-based feed finders — there, absence and a transient
 * server error are indistinguishable by status.
 */
export function isNotFoundError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const status = (error as { status?: unknown }).status
    if (status === NOT_FOUND) return true
    // A real, non-404 numeric status (e.g. 500) is a server error, not a miss —
    // decide on it and never fall through to the message text.
    if (typeof status === "number") return false
  }
  const message = error instanceof Error ? error.message : String(error)
  return /404|not found/i.test(message) // fallback for message-only mocks/wrappers
}

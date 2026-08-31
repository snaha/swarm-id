// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether the proxy iframe can read the trusted domain's first-party store —
 * asked BEFORE authentication, because it decides which transport the auth
 * popup has to take (#613).
 *
 * The mirror image of the probe the connect popup already runs: there, the
 * iframe writes a challenge and the popup checks whether it can read it back
 * first-party (`ui/src/lib/stores/connect.svelte.ts`). That answer arrives far
 * too late to choose a transport, so the same question is asked the other way
 * round — the first-party app leaves a marker, and the iframe reads it back.
 *
 * Deliberately NOT any of these:
 *
 * - **`document.hasStorageAccess()`** — measured 2026-08-31 in the
 *   `chromium-partitioned` rig: it returns `true` inside a genuinely
 *   partitioned frame. It is cookie-scoped, and Chrome partitions storage
 *   separately from cookies, so it answers a different question.
 * - **The accounts key.** The proxy writes `swarm-id-accounts` from inside the
 *   iframe (`clearAuthData`), and the versioned storage manager can materialise
 *   state in a fresh partitioned bucket, so its presence conflates "first-party
 *   storage is visible" with "this partition has its own copy".
 * - **The user agent**, which is what this replaces.
 *
 * The marker only ever answers YES with certainty. Absent means "not proven
 * shared" — a partitioned iframe, or a browser that has never had the SwarmID
 * site open at the top level — and the caller treats that as partitioned,
 * which is the safe direction: the delegated transport works in both modes.
 */
export const STORAGE_SHARED_KEY = "swarm-id-first-party"

/**
 * Leave the marker. Called by the trusted domain's own pages.
 *
 * The framed guard is load-bearing: the proxy route runs the same app shell
 * inside the iframe, and a marker written there would land in the partitioned
 * bucket and make the iframe report itself shared — the one wrong answer this
 * must never give.
 */
export function markFirstPartyStorage(): void {
  try {
    if (typeof window === "undefined" || window.self !== window.top) {
      return
    }
    localStorage.setItem(STORAGE_SHARED_KEY, "1")
  } catch {
    // Storage disabled or full. Nothing to do: an unwritten marker reads as
    // "not proven shared", which is the safe answer.
  }
}

/** Whether this context can see the marker a first-party page left. */
export function isStorageShared(): boolean {
  try {
    return localStorage.getItem(STORAGE_SHARED_KEY) !== null
  } catch {
    return false
  }
}

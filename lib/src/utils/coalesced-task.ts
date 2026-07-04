// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run `task` at most once per `cooldownMs` across all same-origin browser tabs.
 *
 * An exclusive Web Lock (`navigator.locks`, keyed on `lockName`) serialises
 * concurrent callers so two tabs can't run `task` at the same instant; a shared
 * `localStorage` timestamp (`cooldownKey`) then lets the second caller skip when
 * another tab already ran within the window. `force` bypasses the cooldown (e.g.
 * a page load / manual refresh) but still honours the optional short `graceMs`
 * window, so a burst of forced runs (N tabs on load, or two back-to-back forced
 * triggers) still collapses to one.
 *
 * Effect: with several tabs each scheduling the same task, only ONE actually runs
 * per window — the rest observe the fresh timestamp and return. Whatever the task
 * persists (e.g. the account document) then propagates to the other tabs via their
 * own `storage` listeners, so they never need to fetch themselves.
 *
 * Falls back to running `task` directly when the Web Locks API is unavailable
 * (Node / test), still honouring the cooldown when `localStorage` is present.
 */
export async function runCoalescedAcrossTabs(opts: {
  lockName: string
  cooldownKey: string
  cooldownMs: number
  force?: boolean
  /** Short window honoured even under `force` — collapses back-to-back forced runs. */
  graceMs?: number
  task: () => Promise<void>
}): Promise<void> {
  const run = async () => {
    // The grace window applies even under force; the long cooldown only when not forced.
    if (
      opts.graceMs !== undefined &&
      ranWithin(opts.cooldownKey, opts.graceMs)
    ) {
      return
    }
    if (!opts.force && ranWithin(opts.cooldownKey, opts.cooldownMs)) {
      return
    }
    try {
      await opts.task()
    } finally {
      stampNow(opts.cooldownKey)
    }
  }

  if (typeof navigator !== "undefined" && navigator.locks) {
    await navigator.locks.request(opts.lockName, { mode: "exclusive" }, run)
  } else {
    await run()
  }
}

/** True when `key`'s stored epoch-ms timestamp is within `windowMs` of now. */
function ranWithin(key: string, windowMs: number): boolean {
  if (typeof window === "undefined" || !window.localStorage) {
    return false
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return false
  }
  const last = Number(raw)
  return Number.isFinite(last) && Date.now() - last < windowMs
}

/** Record "ran just now" so other tabs in the window skip. */
function stampNow(key: string): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return
  }
  window.localStorage.setItem(key, String(Date.now()))
}

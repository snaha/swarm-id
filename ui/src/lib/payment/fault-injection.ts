// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Deliberate failures, at the points where a real one costs money.
 *
 * The paid operations are hard to test honestly because the interesting case
 * is the one that costs: a purchase whose read-back fails after the batch
 * exists on chain and has been paid for. Waiting for that to happen by
 * accident is how it stays untested — and how a resume path that does not
 * work ships.
 *
 * Armed from /dev, read here. Production code calls `faultPoint` freely: the
 * `DEV` guard is statically false in a production build, so the call sites
 * remain as dead no-ops and the /dev-only helpers behind them tree-shake away.
 */
const STORAGE_KEY = 'swarm-id:fault-point'

/**
 * Where a fault can be injected. Each name is a moment AFTER something
 * irreversible has landed — that is the whole point; failing before a spend
 * proves nothing.
 */
export type FaultPoint =
  | 'none'
  /** After the payment landed at the owner address, before the batch call. */
  | 'after-funding'
  /** After createBatch confirmed, before the drive is recorded. */
  | 'after-create'

export const FAULT_POINTS: FaultPoint[] = ['none', 'after-funding', 'after-create']

/** Human wording for the /dev picker. */
export function describeFaultPoint(point: FaultPoint): string {
  switch (point) {
    case 'after-funding':
      return 'After the payment lands (before the batch call)'
    case 'after-create':
      return 'After the batch is created (before it is recorded)'
    default:
      return 'No injected failure'
  }
}

export function armedFaultPoint(): FaultPoint {
  if (!import.meta.env.DEV || typeof localStorage === 'undefined') {
    return 'none'
  }
  const stored = localStorage.getItem(STORAGE_KEY)
  return FAULT_POINTS.find((point) => point === stored) ?? 'none'
}

export function armFaultPoint(point: FaultPoint): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  if (point === 'none') {
    localStorage.removeItem(STORAGE_KEY)
    return
  }
  localStorage.setItem(STORAGE_KEY, point)
}

/**
 * Throw if this point is armed, and disarm it.
 *
 * Single-shot deliberately: the interesting thing about these failures is what
 * the NEXT attempt does, and an armed point that fired on every attempt would
 * make the resume path unreachable — which is the path under test.
 */
export function faultPoint(point: Exclude<FaultPoint, 'none'>): void {
  if (!import.meta.env.DEV) {
    return
  }
  if (armedFaultPoint() !== point) {
    return
  }
  armFaultPoint('none')
  throw new Error(`Injected failure at "${point}" (armed in /dev → Chain → Simulate failure).`)
}

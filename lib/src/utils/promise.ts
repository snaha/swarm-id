// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Returns a promise that rejects with `new Error(message)` after `ms`
 * milliseconds. Never resolves. Compose with `Promise.race` to time-bound
 * an otherwise pending operation:
 *
 * ```ts
 * await Promise.race([work, rejectAfter(5000, "work timed out")])
 * ```
 */
export function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms)
  })
}

/**
 * Time-bound `work`: resolve/reject with `work` if it settles within `ms`, else
 * reject with `new Error(message)`. Unlike `rejectAfter` composed by hand, the
 * timer is cleared once the race settles, so a fast read leaves no stray timer
 * to fire later (matters in tight read loops). The rejection message is stable,
 * so callers can distinguish a timeout from other failures.
 */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

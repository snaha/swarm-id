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
 * Rejection type for {@link withTimeout}. Callers classify a timed-out read
 * (INCONCLUSIVE — the target may exist behind a slow gateway) apart from a
 * clean miss / other failure with `error instanceof TimeoutError` — never by
 * matching the message text, which is display-only.
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TimeoutError"
  }
}

/**
 * Time-bound `work`: resolve/reject with `work` if it settles within `ms`, else
 * reject with a {@link TimeoutError}. Unlike `rejectAfter` composed by hand,
 * the timer is cleared once the race settles, so a fast read leaves no stray
 * timer to fire later (matters in tight read loops).
 */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

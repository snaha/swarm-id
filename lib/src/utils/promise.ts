// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
 * reject with a {@link TimeoutError}. Unlike a hand-rolled
 * `Promise.race([work, rejectionTimer])`, the timer is cleared once the race
 * settles, so a fast read leaves no stray timer to fire later (matters in
 * tight read loops).
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

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

/**
 * Resolve after `ms` milliseconds — the default delay behind a poll or backoff.
 *
 * A caller whose timing a test needs to drive should keep taking an injectable
 * wait and pass this as its default (as `acquirePartitionLock` does with
 * `opts.wait`) rather than calling it directly, which would pin real time into
 * the test path.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Time-bound `work` by SILENCE rather than by total elapsed time: the deadline
 * is `ms` from the last `keepAlive()` the work reported, or from the start if
 * it has reported nothing. Rejects with a {@link TimeoutError}, like
 * {@link withTimeout}, and clears its timer whichever way the race settles.
 *
 * For work whose total duration is legitimately unbounded but whose *progress*
 * is observable — a payment the user signs in a wallet on another device, a
 * long upload reporting chunks. A total deadline there fails work that is
 * proceeding normally; this one fires only when the reports stop, which is the
 * failure actually worth catching.
 *
 * `work` is a function rather than a promise because it has to be handed the
 * `keepAlive` callback to report through. A synchronous throw from it becomes a
 * rejection, so the timer is cleared on that path too; a `keepAlive` called
 * after the work settles is ignored rather than arming a timer nobody will
 * clear.
 */
export function withIdleTimeout<T>(
  work: (keepAlive: () => void) => Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  let settled = false
  let keepAlive: () => void = () => undefined
  const timeout = new Promise<never>((_, reject) => {
    keepAlive = () => {
      if (settled) {
        return
      }
      clearTimeout(timer)
      timer = setTimeout(() => reject(new TimeoutError(message)), ms)
    }
    keepAlive()
  })
  // Wrapped so that a `work` that throws before its first await rejects rather
  // than escaping past the `finally` that clears the timer.
  const started = (async () => work(keepAlive))()
  return Promise.race([started, timeout]).finally(() => {
    settled = true
    clearTimeout(timer)
  })
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function sleep(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis))
}

export interface RetryOptions {
  /** Failures tolerated before the last error is thrown */
  allowedFailures: number
  /** Delay after the first failure; later delays grow linearly to `lastDelayMillis` */
  firstDelayMillis: number
  lastDelayMillis: number
  onFailure?: (error: unknown, attempt: number) => void
}

export async function withRetries<T>(
  work: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { allowedFailures, firstDelayMillis, lastDelayMillis } = options
  const steps = Math.max(allowedFailures - 1, 1)
  for (let failures = 0; ; failures++) {
    try {
      return await work()
    } catch (error) {
      if (failures >= allowedFailures) {
        throw error
      }
      options.onFailure?.(error, failures + 1)
      await sleep(
        firstDelayMillis +
          (lastDelayMillis - firstDelayMillis) * (failures / steps),
      )
    }
  }
}

export interface WaitOptions {
  attempts: number
  waitMillis: number
}

/** Polls until `predicate` holds; a predicate that throws counts as not yet. */
export async function waitFor(
  predicate: () => Promise<boolean>,
  options: WaitOptions,
): Promise<void> {
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    if (await predicate().catch(() => false)) {
      return
    }
    if (attempt < options.attempts - 1) {
      await sleep(options.waitMillis)
    }
  }
  throw new Error("Timed out waiting for predicate")
}

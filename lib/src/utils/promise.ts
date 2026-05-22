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

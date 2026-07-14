// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Supersedable attempts: only the latest attempt may act on its results.
 *
 * Ceremony handlers (passkey/wallet/password prompts and the async work that
 * follows) must not apply side effects once the user cancelled, retried, or
 * left the page. The hand-rolled `myAttempt !== attempt` counter idiom relied
 * on remembering a re-check after every await — forgetting one caused #423.
 * This helper makes the check structural: route every await through
 * `attempt.guard(...)` and stale continuations throw instead of proceeding.
 *
 * Usage:
 *
 *   const attempts = createAttemptTracker()
 *
 *   async function confirm() {
 *     const attempt = attempts.begin()
 *     try {
 *       const key = await attempt.guard(ceremony())
 *       applySideEffects(key)
 *     } catch (caught) {
 *       if (attempt.current) {
 *         error = message(caught)
 *       }
 *     }
 *   }
 *
 *   function cancel() {
 *     attempts.supersede()
 *   }
 *
 * `guard` does not cancel the underlying work — like the counter it replaces,
 * it discards the result once the work settles (pass `onDiscard` to e.g. zero
 * a decrypted seed). Deliberately awaiting OUTSIDE the guard is the escape
 * hatch for work that must complete and be recorded even after a cancel, such
 * as an on-chain spend.
 */

/**
 * Thrown by `Attempt.guard` when the attempt was superseded while its work ran.
 * It is only ever thrown once `current` is false, so catch blocks gated on
 * `attempt.current` swallow it without needing an instanceof check.
 */
export class SupersededError extends Error {
  constructor() {
    super('Attempt superseded by cancel, retry, or leaving the page')
    this.name = 'SupersededError'
  }
}

export interface Attempt {
  /** True while no newer attempt (begin) or cancel (supersede) replaced this one. */
  readonly current: boolean
  /**
   * Resolve `work`, then throw `SupersededError` if this attempt is no longer
   * current. `onDiscard` runs on the resolved value before the throw — use it
   * to destroy material that must not leak past a cancel (e.g. zero a seed).
   * A rejection of `work` propagates unchanged and never invokes `onDiscard`.
   */
  guard<T>(work: Promise<T>, onDiscard?: (value: T) => void): Promise<T>
}

export interface AttemptTracker {
  /** Start a new attempt, superseding any attempt currently in flight. */
  begin(): Attempt
  /** Invalidate all in-flight attempts without starting a new one (cancel/close/leave). */
  supersede(): void
}

export function createAttemptTracker(): AttemptTracker {
  let latest = 0
  return {
    begin(): Attempt {
      const mine = ++latest
      return {
        get current() {
          return mine === latest
        },
        async guard<T>(work: Promise<T>, onDiscard?: (value: T) => void): Promise<T> {
          const value = await work
          if (mine !== latest) {
            onDiscard?.(value)
            throw new SupersededError()
          }
          return value
        },
      }
    },
    supersede() {
      latest++
    },
  }
}

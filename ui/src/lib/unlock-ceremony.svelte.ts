// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The unlock ceremony without a dialog around it: collect the password, or
 * drive the passkey / wallet prompt, then hand the decrypted entropy to
 * `onunlocked`. `UnlockDialog` wraps it; a form with its own layout (the
 * delete dialog) uses it directly.
 */
import { untrack } from 'svelte'

import { createAttemptTracker } from '$lib/attempt'
import { unlockAccount } from '$lib/crypto/unlock'
import type { Account } from '$lib/types'

export type UnlockCeremony = ReturnType<typeof createUnlockCeremony>

export function createUnlockCeremony(
  account: Account,
  onunlocked: (entropy: Uint8Array) => void | Promise<void>,
) {
  // The method is fixed for a ceremony — read ONCE via `untrack` (not
  // `$derived`) so a mid-ceremony record change (e.g. cross-tab) can never
  // re-render the dialog against different access metadata.
  const access = untrack(() => account.accessMethod)
  // Snapshot the sign-out state to detect a mid-ceremony transition below:
  // this serves both signed-in unlocks and sign-back-in ceremonies, so what
  // invalidates a ceremony is the state CHANGING under it, not being signed
  // out per se.
  const initialSignedOutAt = untrack(() => account.signedOutAt)

  let busy = $state(false)
  let pending = $state(false)
  let error = $state<string | undefined>(undefined)
  /** Cancel/retry supersedes the in-flight ceremony — it must not complete. */
  const attempts = createAttemptTracker()

  async function confirm(password: string) {
    if (busy) {
      return
    }
    const attempt = attempts.begin()
    error = undefined
    busy = true
    if (access.type !== 'password') {
      pending = true
    }
    try {
      // A passkey/wallet unlock can take seconds; a ceremony superseded while
      // it ran (cancel/retry) must not complete, and its decrypted entropy is
      // zeroed on the way out.
      const entropy = await attempt.guard(
        unlockAccount(account, access.type === 'password' ? password : undefined),
        (seed) => seed.fill(0),
      )
      // Bail if the account's sign-out state flipped mid-flight (e.g.
      // cross-tab) — supersession itself is the attempt guard's job. A
      // signed-in unlock completing after a sign-out would re-arm app session
      // material the sign-out just cleared; a sign-back-in completing after
      // another tab already signed back in (or re-signed-out) would act on a
      // state it no longer knows.
      if (account.signedOutAt !== initialSignedOutAt) {
        entropy.fill(0)
        return
      }
      await onunlocked(entropy)
    } catch (caught) {
      if (attempt.current) {
        error = caught instanceof Error ? caught.message : 'Unlock failed.'
        pending = false
      }
    } finally {
      if (attempt.current) {
        busy = false
      }
    }
  }

  return {
    access,
    get busy() {
      return busy
    },
    /** A passkey / wallet prompt is open. */
    get pending() {
      return pending
    },
    get error() {
      return error
    },
    confirm,
    /**
     * Invalidate any in-flight ceremony — wallet prompts can't be aborted, so
     * a later approval of a cancelled prompt must not complete.
     */
    cancel: () => attempts.supersede(),
  }
}

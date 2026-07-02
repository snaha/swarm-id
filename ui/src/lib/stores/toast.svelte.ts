// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * App-wide toast: one message at a time, auto-dismissed. The single `<Toast>`
 * instance in the root layout renders it, so callers just `toastStore.show(…)`
 * — no per-component timer state, and two features toasting in quick
 * succession can't stack overlapping popups.
 */

const TOAST_DURATION_MS = 4000

function withToastStore() {
  let message = $state<string | undefined>(undefined)
  let timer: ReturnType<typeof setTimeout> | undefined

  return {
    get message() {
      return message
    },
    // Arrow so it can be passed around as a bare callback (e.g. `onAdded={toastStore.show}`).
    show: (text: string) => {
      message = text
      clearTimeout(timer)
      timer = setTimeout(() => (message = undefined), TOAST_DURATION_MS)
    },
  }
}

export const toastStore = withToastStore()

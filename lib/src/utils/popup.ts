// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Safari reports a just-opened tab as closed for a moment, so a watch on a
 * popup starts late (as the connect popup's does).
 */
const POPUP_WATCH_DELAY_MS = 2000
const POPUP_CLOSED_POLL_MS = 500
/**
 * How long the permissions popup may stay open before its request is
 * answered anyway: the user is choosing drives, maybe buying one (#711).
 */
export const PERMISSIONS_POPUP_MAX_MS = 10 * 60_000

/**
 * Settles once `popup` is closed, or after `maxMs` whatever its state. The
 * watch starts after {@link POPUP_WATCH_DELAY_MS}, which `maxMs` includes.
 */
export function untilPopupClosed(popup: Window, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now()
    setTimeout(() => {
      const poll = setInterval(() => {
        if (popup.closed || Date.now() - started >= maxMs) {
          clearInterval(poll)
          resolve()
        }
      }, POPUP_CLOSED_POLL_MS)
    }, POPUP_WATCH_DELAY_MS)
  })
}

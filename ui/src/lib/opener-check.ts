// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { withTimeout } from '@snaha/swarm-id'
import { OpenerCheckResponseMessageSchema } from '@snaha/swarm-id/internal'

/** How long the opener gets to answer; it is a page already running, so this is generous. */
export const OPENER_CHECK_TIMEOUT_MS = 5000

/**
 * Whether this popup was really opened for `appOrigin` (#915). The origin on
 * the URL is whatever the opener wrote, and any page can open the connect or
 * permissions page naming any app; the origin of the opener's answer is what
 * the browser vouches for. Two openers pass:
 *
 * - the app page itself, answering from `appOrigin` — the client opened the
 *   popup (`connect()`, `requestDrives()`); the ask aimed at `appOrigin`
 *   reaches no page on any other origin;
 * - the proxy iframe, answering from this origin with the parent origin it
 *   verified when it was identified, which must be `appOrigin` — its own
 *   button opened the popup.
 *
 * No opener, an answer naming another origin, or none in time: refused.
 */
export async function verifyOpener(
  appOrigin: string,
  timeoutMs: number = OPENER_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  const opener: Window | null = window.opener
  if (!opener) {
    return false
  }
  const nonce = crypto.randomUUID()
  let listener: ((event: MessageEvent) => void) | undefined
  const answered = new Promise<boolean>((resolve) => {
    listener = (event: MessageEvent) => {
      if (event.source !== opener) {
        return
      }
      const answer = OpenerCheckResponseMessageSchema.safeParse(event.data)
      if (!answer.success || answer.data.nonce !== nonce) {
        return
      }
      if (event.origin === appOrigin) {
        resolve(true)
      } else if (event.origin === window.location.origin) {
        resolve(answer.data.parentOrigin === appOrigin)
      } else {
        resolve(false)
      }
    }
    window.addEventListener('message', listener)
  })
  try {
    const ask = { type: 'openerCheck', nonce }
    opener.postMessage(ask, appOrigin)
    opener.postMessage(ask, window.location.origin)
    return await withTimeout(answered, timeoutMs, 'The opener did not answer')
  } catch {
    // No answer in time, or `appOrigin` is no origin postMessage can target.
    return false
  } finally {
    if (listener) window.removeEventListener('message', listener)
  }
}

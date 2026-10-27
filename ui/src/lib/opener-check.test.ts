// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Who opened the connect or permissions popup (#915). The app origin comes
 * from the URL, which any page can write; only the browser's `event.origin`
 * on the opener's answer says who actually asked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { verifyOpener } from '$lib/opener-check'

const APP = 'https://app.example'
const ID = 'https://id.example'
const OTHER = 'https://evil.example'
const TIMEOUT_MS = 50

type Listener = (event: MessageEvent) => void

/** A popup window whose opener records what it is asked, and can answer. */
function stubPopup(options: { opener?: boolean } = {}) {
  const listeners: Listener[] = []
  const opener = { postMessage: vi.fn() }
  vi.stubGlobal('window', {
    location: { origin: ID },
    opener: options.opener === false ? null : opener,
    addEventListener: (type: string, listener: Listener) => {
      if (type === 'message') listeners.push(listener)
    },
    removeEventListener: (type: string, listener: Listener) => {
      const index = listeners.indexOf(listener)
      if (type === 'message' && index >= 0) listeners.splice(index, 1)
    },
  })
  const nonce = () => opener.postMessage.mock.calls[0]?.[0]?.nonce as string
  return {
    opener,
    /** Deliver an answer the way the browser would. */
    answer(origin: string, data: Record<string, unknown>, source: unknown = opener) {
      for (const listener of [...listeners]) {
        listener({ origin, source, data } as unknown as MessageEvent)
      }
    },
    nonce,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('verifyOpener', () => {
  it('asks the opener on the claimed origin and on its own', () => {
    const popup = stubPopup()
    void verifyOpener(APP, TIMEOUT_MS)

    expect(popup.opener.postMessage).toHaveBeenCalledWith(
      { type: 'openerCheck', nonce: popup.nonce() },
      APP,
    )
    expect(popup.opener.postMessage).toHaveBeenCalledWith(
      { type: 'openerCheck', nonce: popup.nonce() },
      ID,
    )
  })

  // The app page opened the popup: library `connect()` or `requestDrives()`.
  it('trusts an answer from the claimed origin', async () => {
    const popup = stubPopup()
    const verified = verifyOpener(APP, TIMEOUT_MS)
    popup.answer(APP, { type: 'openerCheckResponse', nonce: popup.nonce() })
    await expect(verified).resolves.toBe(true)
  })

  // The proxy iframe opened it, from its own button: same origin as the
  // popup, vouching for the parent origin it verified itself.
  it('trusts the proxy vouching for the claimed origin', async () => {
    const popup = stubPopup()
    const verified = verifyOpener(APP, TIMEOUT_MS)
    popup.answer(ID, { type: 'openerCheckResponse', nonce: popup.nonce(), parentOrigin: APP })
    await expect(verified).resolves.toBe(true)
  })

  it('refuses the proxy vouching for another origin', async () => {
    const popup = stubPopup()
    const verified = verifyOpener(APP, TIMEOUT_MS)
    popup.answer(ID, { type: 'openerCheckResponse', nonce: popup.nonce(), parentOrigin: OTHER })
    await expect(verified).resolves.toBe(false)
  })

  // The forged case: a page on another origin opened the popup naming APP.
  // The ask aimed at APP never reaches it, and whatever it answers comes
  // from its own origin.
  it('refuses an opener that answers from another origin', async () => {
    const popup = stubPopup()
    const verified = verifyOpener(APP, TIMEOUT_MS)
    popup.answer(OTHER, { type: 'openerCheckResponse', nonce: popup.nonce() })
    await expect(verified).resolves.toBe(false)
  })

  it('ignores answers from other windows, or with another nonce, until the deadline', async () => {
    const popup = stubPopup()
    const verified = verifyOpener(APP, TIMEOUT_MS)
    popup.answer(APP, { type: 'openerCheckResponse', nonce: popup.nonce() }, {})
    popup.answer(APP, { type: 'openerCheckResponse', nonce: 'not-ours' })
    await expect(verified).resolves.toBe(false)
  })

  it('refuses without an opener', async () => {
    stubPopup({ opener: false })
    await expect(verifyOpener(APP, TIMEOUT_MS)).resolves.toBe(false)
  })

  it('refuses a claimed origin that is no origin', async () => {
    stubPopup()
    await expect(verifyOpener('not a url', TIMEOUT_MS)).resolves.toBe(false)
  })
})

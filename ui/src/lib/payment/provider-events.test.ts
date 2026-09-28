// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest'

import type { EthereumProvider } from '$lib/payment/payment-rail'
import { subscribeProviderEvent } from '$lib/payment/provider-events'

/** A provider whose `removeListener` removes nothing, like Coinbase's. */
function stubProvider() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const provider: EthereumProvider = {
    request: () => Promise.resolve(undefined),
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    removeListener: () => undefined,
  }
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload)
    }
  }
  const count = (event: string) => listeners.get(event)?.length ?? 0
  return { provider, emit, count }
}

describe('subscribeProviderEvent', () => {
  it('delivers events to a subscribed handler', () => {
    const { provider, emit } = stubProvider()
    const handler = vi.fn()
    subscribeProviderEvent(provider, 'accountsChanged', handler)

    emit('accountsChanged', ['0xabc'])

    expect(handler).toHaveBeenCalledExactlyOnceWith(['0xabc'])
  })

  it('stops delivering once unsubscribed, though removeListener is a no-op', () => {
    const { provider, emit } = stubProvider()
    const handler = vi.fn()
    const unsubscribe = subscribeProviderEvent(provider, 'accountsChanged', handler)

    unsubscribe()
    emit('accountsChanged', ['0xabc'])

    expect(handler).not.toHaveBeenCalled()
  })

  it('installs one listener per event however many cycles it goes through', () => {
    const { provider, emit, count } = stubProvider()
    const stale = vi.fn()
    const CYCLES = 5
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      subscribeProviderEvent(provider, 'accountsChanged', stale)()
      subscribeProviderEvent(provider, 'chainChanged', stale)()
    }
    const current = vi.fn()
    subscribeProviderEvent(provider, 'accountsChanged', current)

    emit('accountsChanged', ['0xabc'])
    emit('chainChanged', '0x1')

    expect(count('accountsChanged')).toBe(1)
    expect(count('chainChanged')).toBe(1)
    expect(stale).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledOnce()
  })

  it('keeps providers apart', () => {
    const first = stubProvider()
    const second = stubProvider()
    const handler = vi.fn()
    subscribeProviderEvent(first.provider, 'chainChanged', handler)

    second.emit('chainChanged', '0x1')

    expect(handler).not.toHaveBeenCalled()
  })

  it('does nothing for a provider that emits no events', () => {
    const provider: EthereumProvider = { request: () => Promise.resolve(undefined) }

    expect(() => subscribeProviderEvent(provider, 'chainChanged', vi.fn())()).not.toThrow()
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The rail's own failure bound. Relay's pricing and step model are contract-
 * tested against the live API in `relay.live.test.ts`; what cannot be observed
 * there is an SDK that simply never comes back, which is what this covers.
 */
import { TimeoutError } from '@snaha/swarm-id'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NATIVE_CURRENCY } from '$lib/payment/payment-rail'

import { relayRail } from './relay'

/** An `execute` that accepts the payment and then goes quiet forever. */
const execute = vi.fn(() => new Promise<void>(() => undefined))

vi.mock('@relayprotocol/relay-sdk', () => ({
  MAINNET_RELAY_API: 'https://api.relay.link',
  createClient: () => undefined,
  getClient: () => ({ actions: { execute } }),
}))

const TEN_MINUTES_MS = 600_000

describe('relay execute', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails the payment when the SDK stops reporting, rather than spinning forever', async () => {
    vi.useFakeTimers()
    const payment = relayRail.execute({
      quote: { handle: {}, amountFormatted: '0.001', amountUsd: '0.01' },
      provider: { request: () => Promise.resolve(undefined) },
      chainId: 8453,
      currency: NATIVE_CURRENCY,
      address: '0xpayer',
    })
    const rejected = expect(payment).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS)
    await rejected
    // The user is told it may have landed — the retry re-prices against the
    // owner address rather than assuming the money stayed put.
    await expect(payment).rejects.toThrow(/may still land/)
  })
})

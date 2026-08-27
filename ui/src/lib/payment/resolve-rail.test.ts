// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { gnosis } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NATIVE_CURRENCY, type PaymentToken } from '$lib/payment/payment-rail'
import { resolvePaymentRail } from '$lib/payment/resolve-rail'

const XDAI: PaymentToken = { address: NATIVE_CURRENCY, symbol: 'xDAI', name: 'xDAI', decimals: 18 }

/**
 * The direct rail is mocked at its own module so the choice is all that is under
 * test — the real one probes both the configured endpoint and the wallet.
 */
const { resolveGnosisDirectRail } = vi.hoisted(() => ({ resolveGnosisDirectRail: vi.fn() }))

vi.mock('$lib/payment/gnosis-direct', () => ({ resolveGnosisDirectRail }))

/** The direct rail: Gnosis only, and only its native token — it is a transfer. */
const direct = {
  chains: [gnosis],
  tokens: () => [XDAI],
  quote: vi.fn(() => Promise.resolve({ handle: undefined, amountFormatted: '', amountUsd: '' })),
  execute: vi.fn(() => Promise.resolve()),
}

describe('resolvePaymentRail', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('pays from Gnosis when the endpoint and wallet can carry it', async () => {
    resolveGnosisDirectRail.mockResolvedValue(direct)
    const rail = await resolvePaymentRail()
    expect(rail?.chains.map((chain) => chain.id)).toEqual([gnosis.id])
  })

  /**
   * Nothing offered is the honest answer. The funding seam turns it into an
   * error the user can act on, which is strictly better than signing a payment
   * onto a chain that cannot reach the batch owner.
   */
  it('has no rail to give when the direct rail does not resolve', async () => {
    resolveGnosisDirectRail.mockResolvedValue(undefined)
    await expect(resolvePaymentRail()).resolves.toBeUndefined()
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { gnosis, mainnet } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  NATIVE_CURRENCY,
  type PaymentRail,
  type PaymentToken,
  type QuoteRequest,
} from '$lib/payment/payment-rail'
import { combineRails, resolvePaymentRail } from '$lib/payment/resolve-rail'

const USDC: PaymentToken = {
  address: '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
}
const XDAI: PaymentToken = { address: NATIVE_CURRENCY, symbol: 'xDAI', name: 'xDAI', decimals: 18 }
const ETH: PaymentToken = { address: NATIVE_CURRENCY, symbol: 'ETH', name: 'Ether', decimals: 18 }

/**
 * Both rails are mocked at their own module so the choice is all that is under
 * test — the real ones probe an RPC endpoint and a hosted quoting API.
 */
const { resolveGnosisDirectRail } = vi.hoisted(() => ({ resolveGnosisDirectRail: vi.fn() }))

vi.mock('$lib/payment/gnosis-direct', () => ({ resolveGnosisDirectRail }))
// Built inside the factory, not from `bridged` below: the factory runs while
// this module's own top-level consts are still in their temporal dead zone.
// `stubRail` is a function declaration, so it is hoisted and available.
vi.mock('$lib/payment/relay', () => ({ relayRail: stubRail([mainnet, gnosis], {}) }))

function stubRail(chains: PaymentRail['chains'], tokens: Record<number, PaymentToken[]>) {
  return {
    chains,
    tokens: (chainId: number) => tokens[chainId] ?? [],
    quote: vi.fn(() => Promise.resolve({ handle: undefined, amountFormatted: '', amountUsd: '' })),
    execute: vi.fn(() => Promise.resolve()),
  }
}

/** The direct rail: Gnosis only, and only its native token — it is a transfer. */
const direct = stubRail([gnosis], { [gnosis.id]: [XDAI] })
/** The bridged rail: every chain, native + a stablecoin. */
const bridged = stubRail([mainnet, gnosis], {
  [mainnet.id]: [ETH, USDC],
  [gnosis.id]: [XDAI, USDC],
})

const request = (chainId: number, currency: string): QuoteRequest => ({
  chainId,
  currency,
  user: '0x1111111111111111111111111111111111111111',
  recipient: '0x2222222222222222222222222222222222222222',
  xdaiWei: 10n ** 18n,
})

describe('combineRails', () => {
  it('lists each chain once, in rail order', () => {
    expect(combineRails([direct, bridged]).chains.map((chain) => chain.id)).toEqual([
      gnosis.id,
      mainnet.id,
    ])
  })

  /**
   * Dispatch is per TOKEN, not per chain. Were it per chain, the direct rail —
   * offered first because paying from Gnosis needs no bridge — would claim all
   * of Gnosis; it moves native xDAI only, so Gnosis USDC would silently vanish
   * from the picker and anyone holding it there could not pay from Gnosis at
   * all. Invisible locally, where nobody has USDC.
   */
  it('keeps a chain’s other tokens with the rail that can carry them', () => {
    const combined = combineRails([direct, bridged])
    expect(combined.tokens(gnosis.id)).toEqual([XDAI, USDC])

    void combined.quote(request(gnosis.id, USDC.address))
    expect(bridged.quote).toHaveBeenCalledOnce()
    expect(direct.quote).not.toHaveBeenCalled()
  })

  it('gives the earlier rail the token both offer', () => {
    const combined = combineRails([direct, bridged])
    void combined.quote(request(gnosis.id, NATIVE_CURRENCY))
    expect(direct.quote).toHaveBeenCalledOnce()
  })

  it('refuses a token no rail serves rather than picking one that cannot', () => {
    const combined = combineRails([direct, bridged])
    expect(() => combined.quote(request(gnosis.id, '0xdeadbeef'))).toThrow(/No payment route/)
  })
})

describe('resolvePaymentRail', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  /** The chains the resolved rail offers, which say which rails were combined. */
  async function resolvedChains() {
    const rail = await resolvePaymentRail()
    return rail?.chains.map((chain) => chain.id)
  }

  it('leads with Gnosis when the endpoint and wallet can carry a direct payment', async () => {
    resolveGnosisDirectRail.mockResolvedValue(direct)
    expect(await resolvedChains()).toEqual([gnosis.id, mainnet.id])
  })

  /**
   * An endpoint the direct rail refuses is not a payment that cannot be made:
   * Relay reaches Gnosis from any chain it serves, this one included.
   */
  it('still offers the bridged rail when the direct one does not resolve', async () => {
    resolveGnosisDirectRail.mockResolvedValue(undefined)
    expect(await resolvedChains()).toEqual([mainnet.id, gnosis.id])
  })
})

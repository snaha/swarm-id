// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { gnosis, mainnet } from 'viem/chains'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChainIdentity } from '$lib/payment/chain'
import {
  NATIVE_CURRENCY,
  type PaymentRail,
  type PaymentToken,
  type QuoteRequest,
} from '$lib/payment/payment-rail'
import { combineRails, resolvePaymentRail } from '$lib/payment/resolve-rail'

/**
 * One identity for the whole app, as in production: `resolveGnosisDirectRail`
 * asks the same question, so mocking the answer — rather than the rail — keeps
 * the two rails' views of the endpoint consistent the way they are at runtime.
 */
const endpoint = vi.hoisted(() => ({
  identity: (): Promise<ChainIdentity> => Promise.resolve({ chainId: 100, kind: 'mainnet' }),
}))

vi.mock('$lib/payment/chain', () => ({
  chainIdentity: () => endpoint.identity(),
  postageChain: () => Promise.resolve({}),
}))
vi.mock('$lib/stores/network-settings.svelte', () => ({
  networkSettingsStore: { gnosisRpcUrl: 'https://rpc.gnosischain.com' },
}))

const USDC: PaymentToken = {
  address: '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
}
const XDAI: PaymentToken = { address: NATIVE_CURRENCY, symbol: 'xDAI', name: 'xDAI', decimals: 18 }
const ETH: PaymentToken = { address: NATIVE_CURRENCY, symbol: 'ETH', name: 'Ether', decimals: 18 }

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

// The stub rails are shared, so their call counts have to be — otherwise a
// `toHaveBeenCalledOnce` passes or fails on what an earlier test happened to do.
beforeEach(() => {
  vi.clearAllMocks()
  endpoint.identity = () => Promise.resolve({ chainId: 100, kind: 'mainnet' })
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
  it('offers the bridged chains on Gnosis mainnet', async () => {
    const rail = await resolvePaymentRail()
    expect(rail?.chains.map((chain) => chain.id)).toContain(mainnet.id)
    // Gnosis still leads: paying from the destination chain needs no bridge.
    expect(rail?.chains[0].id).toBe(gnosis.id)
  })

  /**
   * The one that costs real money. Relay is an intent network settled by
   * solvers on REAL Gnosis: offered against a local chain, a payment from
   * Ethereum would be genuinely spent and genuinely delivered — to an address
   * on a chain the operation is not even watching, while it polls localhost for
   * funds that will never arrive.
   */
  it('offers nothing to bridge onto a dev chain', async () => {
    endpoint.identity = () => Promise.resolve({ chainId: 100, kind: 'dev' })
    const rail = await resolvePaymentRail()
    expect(rail?.chains.map((chain) => chain.id)).toEqual([gnosis.id])
  })

  it('offers no rail at all when the endpoint is not Gnosis', async () => {
    endpoint.identity = () => Promise.resolve({ chainId: 1, kind: 'unsupported' })
    await expect(resolvePaymentRail()).resolves.toBeUndefined()
  })

  it('offers no rail when the endpoint cannot be identified', async () => {
    // Unproven is not mainnet. The funding seam turns this into "no payment
    // route is available", which is the honest thing to say.
    endpoint.identity = () => Promise.reject(new Error('the RPC answered 429'))
    await expect(resolvePaymentRail()).resolves.toBeUndefined()
  })
})

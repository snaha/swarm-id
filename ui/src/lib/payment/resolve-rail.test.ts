// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { foundry, gnosis, mainnet } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChainIdentity } from '$lib/payment/chain'
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
 * The three rails `resolvePaymentRail` chooses between, each mocked at its own
 * module so the choice is all that is under test — the real ones probe an RPC
 * endpoint, a hosted quoting API and localhost respectively.
 */
const { chainIdentity, resolveLocalRail, resolveGnosisDirectRail } = vi.hoisted(() => ({
  chainIdentity: vi.fn(),
  resolveLocalRail: vi.fn(),
  resolveGnosisDirectRail: vi.fn(),
}))

vi.mock('$lib/payment/chain', () => ({ chainIdentity }))
vi.mock('$lib/payment/dev-funding', () => ({ resolveLocalRail }))
vi.mock('$lib/payment/gnosis-direct', () => ({ resolveGnosisDirectRail }))
vi.mock('$lib/payment/relay', () => ({ relayRail: stubRail([mainnet], {}) }))

function stubRail(chains: PaymentRail['chains'], tokens: Record<number, PaymentToken[]>) {
  return {
    chains,
    tokens: (chainId: number) => tokens[chainId] ?? [],
    quote: vi.fn(() =>
      Promise.resolve({
        handle: undefined,
        amountFormatted: '',
        amountUsd: '',
        delivers: { input: 'xdai' as const, amount: 0n },
      }),
    ),
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
  bzzPlur: 0n,
  gasXdaiWei: 0n,
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

/**
 * Which bridged rail — if any — each answer about the configured endpoint
 * earns. A test run is a dev build, so this is the branch that decides between
 * Relay and the local stand-in; a production build returns Relay before asking
 * at all.
 *
 * The direct rail is stubbed present throughout, so what changes between these
 * cases is only the bridged half.
 */
describe('resolvePaymentRail', () => {
  const local = stubRail([foundry], { [foundry.id]: [ETH] })

  afterEach(() => {
    vi.clearAllMocks()
  })

  /** The chains the resolved rail offers, which say which rails were combined. */
  async function resolvedChains(identity: (() => Promise<ChainIdentity>) | undefined) {
    chainIdentity.mockImplementation(
      identity ?? (() => Promise.reject(new Error('endpoint unreachable'))),
    )
    resolveGnosisDirectRail.mockResolvedValue(direct)
    resolveLocalRail.mockResolvedValue(local)
    const rail = await resolvePaymentRail()
    return rail?.chains.map((chain) => chain.id)
  }

  // The genesis hash only has to be present and distinct per kind here: which
  // rail resolves turns on `kind`, and the hash is what the payment screens
  // later compare the wallet against, not this choice.
  const identity = (kind: ChainIdentity['kind']) => () =>
    Promise.resolve({
      chainId: kind === 'unsupported' ? 1 : 100,
      genesisHash: `0x${kind}`,
      kind,
    })

  it('sends real Gnosis to Relay, not to a local stand-in', async () => {
    expect(await resolvedChains(identity('mainnet'))).toEqual([gnosis.id, mainnet.id])
    expect(resolveLocalRail).not.toHaveBeenCalled()
  })

  it('offers the local rail on a chain proven to be a dev one', async () => {
    expect(await resolvedChains(identity('dev'))).toEqual([gnosis.id, foundry.id])
  })

  /**
   * The defect this closes. A genesis probe that blips — a rate limit, a
   * dropped connection — used to be routed exactly like a proven dev chain, so
   * a wallet pointed at REAL Gnosis was offered a rail whose deposit goes to a
   * local chain and whose delivery waits two minutes on a solver that was
   * never involved, before blaming it. Unprovable is not dev.
   */
  it('offers no bridged rail when the endpoint could not be identified', async () => {
    expect(await resolvedChains(undefined)).toEqual([gnosis.id])
    expect(resolveLocalRail).not.toHaveBeenCalled()
  })

  it('offers no bridged rail for a chain that is not Gnosis at all', async () => {
    expect(await resolvedChains(identity('unsupported'))).toEqual([gnosis.id])
    expect(resolveLocalRail).not.toHaveBeenCalled()
  })

  it('has no rail to give when neither half resolves', async () => {
    chainIdentity.mockImplementation(identity('unsupported'))
    resolveGnosisDirectRail.mockResolvedValue(undefined)
    await expect(resolvePaymentRail()).resolves.toBeUndefined()
  })
})

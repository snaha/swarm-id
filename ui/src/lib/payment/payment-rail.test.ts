// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { gnosis } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'

import {
  displayAmount,
  displayUsd,
  isUnrecognizedChainError,
  switchWalletChain,
} from '$lib/payment/payment-rail'

/**
 * The two figures the pay screen stacks on top of each other, and the same
 * `displayUsd` the drive dialogs price their estimate with. Rails hand back
 * wildly different precision, so what they render is decided here, not there.
 */
describe('displayAmount', () => {
  it('cuts a rail’s raw precision down to significant digits', () => {
    // A native-token amount as a rail hands it over: the full wei expansion.
    expect(displayAmount('0.000043465998997394')).toBe('0.00004347')
  })

  it('drops the zeros toPrecision pads back on', () => {
    expect(displayAmount('1.5')).toBe('1.5')
    expect(displayAmount(2)).toBe('2')
  })

  /**
   * Padding is only ever after a decimal point: a four-significant-digit integer
   * keeps its REAL zeros, so 1230 must not render as 123 — an order of magnitude
   * off, in a figure the user is about to pay.
   */
  it('keeps the zeros that are part of the number', () => {
    expect(displayAmount(1230)).toBe('1230')
    expect(displayAmount(1000)).toBe('1000')
    expect(displayAmount(9990)).toBe('9990')
  })

  it('has nothing to show for a non-figure or a non-positive one', () => {
    expect(displayAmount('')).toBe('')
    expect(displayAmount('nonsense')).toBe('')
    expect(displayAmount(0)).toBe('')
    expect(displayAmount(-1)).toBe('')
  })

  /**
   * `toPrecision` reaches for exponential notation outside a narrow middle
   * band — at four significant digits, from 10000 up and below 1e-7 — and the
   * pay screen renders whatever comes back verbatim. "1.235e+4" is not a price
   * anyone can read, and next to a token symbol it invites reading the
   * exponent as part of the amount.
   */
  it('never falls back to exponential notation', () => {
    expect(displayAmount(12345)).toBe('12350')
    expect(displayAmount(123456789)).toBe('123500000')
    expect(displayAmount(0.0000000025)).toBe('0.0000000025')
    expect(displayAmount('0.000000000000000001')).toBe('0.000000000000000001')
  })
})

describe('displayUsd', () => {
  it('shows cents for ordinary figures', () => {
    expect(displayUsd(1.5852)).toBe('1.59')
    expect(displayUsd('0.17')).toBe('0.17')
    expect(displayUsd(7.048359592682033)).toBe('7.05')
  })

  /**
   * A small drive genuinely costs a fraction of a cent to extend, so cents
   * alone would render a real price as "0.00" — free, rather than cheap.
   */
  it('shows significant digits below a cent', () => {
    expect(displayUsd(0.0034)).toBe('0.0034')
    expect(displayUsd(0.00012)).toBe('0.00012')
    expect(displayUsd(0.0005)).toBe('0.0005')
  })

  /**
   * A rail whose source could not price the payment passes `''` rather than
   * inventing a figure. Formatted as '0.00' it would read as "~0.00 USD total"
   * under a blank cost line; empty is what every caller renders behind a
   * truthiness test.
   */
  it('has nothing to show for a missing or non-positive figure', () => {
    expect(displayUsd('')).toBe('')
    expect(displayUsd('nonsense')).toBe('')
    expect(displayUsd(0)).toBe('')
    expect(displayUsd(-1)).toBe('')
  })

  /**
   * Two significant digits put `toPrecision`'s exponential threshold at a
   * hundredth of a cent — well inside the range a per-day drive cost lands in
   * — so "$1.0e-8" was a figure the cost line could genuinely reach.
   */
  it('spells a very small dollar figure out rather than exponentiating it', () => {
    expect(displayUsd(0.00000001)).toBe('0.00000001')
    expect(displayUsd(0.0000000025)).toBe('0.0000000025')
  })
})

/**
 * The switch-chain failure that deserves an add-network prompt, told apart
 * from every other one. Fixtures are literal, because the shapes are what real
 * providers really send — the point is the wrapping, not the reading.
 */
describe('isUnrecognizedChainError', () => {
  it('takes EIP-1193’s own code, where a browser extension puts it', () => {
    expect(isUnrecognizedChainError({ code: 4902, message: 'Unrecognized chain ID' })).toBe(true)
  })

  /**
   * MetaMask over WalletConnect: the relay reports its own generic "internal
   * error" and keeps the provider's answer a level down.
   */
  it('digs the code out of a relay’s internal-error wrapper', () => {
    expect(
      isUnrecognizedChainError({
        code: -32603,
        message: 'Internal JSON-RPC error.',
        data: { originalError: { code: 4902 } },
      }),
    ).toBe(true)
    expect(isUnrecognizedChainError({ code: -32603, data: { code: 4902 } })).toBe(true)
  })

  it('falls back to the message when the code was lost entirely', () => {
    expect(isUnrecognizedChainError(new Error('Unrecognized chain ID. Try adding it first.'))).toBe(
      true,
    )
  })

  /**
   * A user's own "no" is never an unrecognised chain, however it is wrapped.
   * Answering it with an add-network dialog would be the app arguing with a
   * decision they just made.
   */
  it('never reads a user’s rejection as a missing chain', () => {
    expect(isUnrecognizedChainError({ code: 4001, message: 'User rejected the request.' })).toBe(
      false,
    )
    expect(
      isUnrecognizedChainError({ code: -32603, data: { originalError: { code: 4001 } } }),
    ).toBe(false)
  })

  it('leaves an unrelated failure alone', () => {
    expect(isUnrecognizedChainError(new Error('Network request failed'))).toBe(false)
    expect(isUnrecognizedChainError({ code: -32000, message: 'insufficient funds' })).toBe(false)
    expect(isUnrecognizedChainError(undefined)).toBe(false)
  })
})

/**
 * Getting the wallet onto the chain the payment will be signed on — which is
 * not the same as the wallet having heard of it.
 */
describe('switchWalletChain', () => {
  const GNOSIS_HEX = '0x64'

  /** A wallet that knows no chains until one is added, recording every call. */
  function wallet(knownChains: string[]) {
    const known = new Set(knownChains)
    const calls: string[] = []
    const provider = {
      request({ method, params = [] }: { method: string; params?: unknown[] }) {
        calls.push(method)
        const [argument] = params as [{ chainId: string }]
        if (method === 'wallet_switchEthereumChain' && !known.has(argument.chainId)) {
          return Promise.reject({ code: 4902, message: 'Unrecognized chain ID' })
        }
        if (method === 'wallet_addEthereumChain') {
          known.add(argument.chainId)
        }
        return Promise.resolve(undefined)
      },
    }
    return { provider, calls }
  }

  it('asks once when the wallet already knows the chain', async () => {
    const { provider, calls } = wallet([GNOSIS_HEX])
    await switchWalletChain(provider, gnosis.id, [gnosis])
    expect(calls).toEqual(['wallet_switchEthereumChain'])
  })

  /**
   * Adding a network is not being on it. Several wallets add without switching,
   * and the payment would then be signed on whatever chain was there before —
   * which the local and the real Gnosis both answer to as chain id 100.
   */
  it('switches again after adding the chain', async () => {
    const { provider, calls } = wallet([])
    await switchWalletChain(provider, gnosis.id, [gnosis])
    expect(calls).toEqual([
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
    ])
  })

  it('fails the way a refused switch does when the second one is declined', async () => {
    const declined = { code: 4001, message: 'User rejected the request.' }
    const request = vi
      .fn()
      .mockRejectedValueOnce({ code: 4902, message: 'Unrecognized chain ID' })
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(declined)
    await expect(switchWalletChain({ request }, gnosis.id, [gnosis])).rejects.toBe(declined)
  })
})

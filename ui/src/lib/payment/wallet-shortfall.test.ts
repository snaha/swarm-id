// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import { NATIVE_CURRENCY } from '$lib/payment/payment-rail'

import { formatBalance, shortfallMessage } from './wallet-shortfall'

const XDAI = { address: NATIVE_CURRENCY, symbol: 'xDAI', name: 'xDAI', decimals: 18 }
const USDC = {
  address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
}
const TOKENS = [XDAI, USDC]
const PRICE = parseUnits('0.5237', XDAI.decimals)

function holding(figures: Record<string, bigint>) {
  return (currency: string): bigint | undefined => figures[currency]
}

function message(charges: { currency: string; amount: bigint }[], figures: Record<string, bigint>) {
  return shortfallMessage(charges, TOKENS, holding(figures), 'Gnosis Chain')
}

describe('shortfallMessage', () => {
  it('says what the wallet holds, and leaves the price to the headline', () => {
    expect(message([{ currency: NATIVE_CURRENCY, amount: PRICE }], { [NATIVE_CURRENCY]: 0n })).toBe(
      'Your wallet has 0 xDAI on Gnosis Chain, not enough for this payment. Choose another chain or token, or add funds to this one.',
    )
  })

  it('formats amounts in the token’s own decimals', () => {
    expect(
      message([{ currency: USDC.address, amount: 10_836_000n }], { [USDC.address]: 2_500_000n }),
    ).toMatch(/has 2\.5 USDC on Gnosis Chain, not enough/)
  })

  it('never shows a near miss as the price itself', () => {
    // 10.835 to nearest would read 10.84 — the 10.836 price in the headline.
    expect(
      message([{ currency: USDC.address, amount: 10_836_000n }], { [USDC.address]: 10_835_000n }),
    ).toMatch(/has 10\.83 USDC on Gnosis Chain, not enough/)
  })

  it('lets through a wallet holding exactly what is charged', () => {
    expect(
      message([{ currency: NATIVE_CURRENCY, amount: PRICE }], { [NATIVE_CURRENCY]: PRICE }),
    ).toBe('')
  })

  it('never blocks on a balance that has not been read', () => {
    expect(message([{ currency: NATIVE_CURRENCY, amount: PRICE }], {})).toBe('')
  })

  it('never blocks on a token the picker does not list', () => {
    expect(message([{ currency: '0xunlisted', amount: PRICE }], { '0xunlisted': 0n })).toBe('')
  })

  it('catches the gas leg when the token leg is covered', () => {
    const gas = parseUnits('0.005', XDAI.decimals)
    expect(
      message(
        [
          { currency: USDC.address, amount: 10_836_000n },
          { currency: NATIVE_CURRENCY, amount: gas },
        ],
        { [USDC.address]: 50_000_000n, [NATIVE_CURRENCY]: parseUnits('0.001', XDAI.decimals) },
      ),
    ).toMatch(/has 0\.001 xDAI on Gnosis Chain, not enough/)
  })
})

describe('formatBalance', () => {
  it('shows an empty balance as 0', () => {
    expect(formatBalance(0n, USDC.decimals)).toBe('0')
  })

  it('never rounds a balance up past what the wallet holds', () => {
    expect(formatBalance(10_839_999n, USDC.decimals)).toBe('10.83')
  })
})

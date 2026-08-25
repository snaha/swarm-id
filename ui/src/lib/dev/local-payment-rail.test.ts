// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { parseEther } from 'viem'
import { describe, expect, it } from 'vitest'

import { quoteLocalPayment } from './local-payment-rail'

/** A canonical request; override the xDAI target per test. */
function request(xdaiWei: bigint) {
  return {
    chainId: 31337,
    currency: '0x0000000000000000000000000000000000000000',
    user: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    recipient: '0x1111111111111111111111111111111111111111',
    xdaiWei,
    bzzPlur: 0n,
    gasXdaiWei: 0n,
  }
}

describe('quoteLocalPayment', () => {
  it('converts the xDAI target to a source amount at the fixed rate', () => {
    // 4000 xDAI per source unit, so 4 xDAI costs 0.001 of the source token.
    expect(quoteLocalPayment(request(parseEther('4'))).amountFormatted).toBe('0.001')
  })

  it('prices in USD from the xDAI target, which is a dollar stablecoin', () => {
    expect(quoteLocalPayment(request(parseEther('4'))).amountUsd).toBe('4.00')
  })

  it('trims trailing zeros but keeps a whole number intact', () => {
    const whole = quoteLocalPayment(request(parseEther('4000')))
    expect(whole.amountFormatted).toBe('1')
  })

  it('formats an amount at the magnitude a real extend costs', () => {
    // A few cents of xDAI — the size these operations actually are.
    const quote = quoteLocalPayment(request(parseEther('0.06')))
    expect(quote.amountFormatted).toBe('0.000015')
    expect(quote.amountUsd).toBe('0.06')
  })

  it('caps the displayed precision rather than leaking every wei digit', () => {
    // Eighteen decimals beside the dialog's four-digit breakdown row reads as a
    // different rail; Relay hands back a short figure and so must this.
    const quote = quoteLocalPayment(request(123456789012345678n))
    expect(quote.amountFormatted).toBe('0.00003086')
  })

  it('carries the recipient and the exact xDAI to deliver in its handle', () => {
    const xdaiWei = parseEther('0.06')
    expect(quoteLocalPayment(request(xdaiWei)).handle).toEqual({
      recipient: '0x1111111111111111111111111111111111111111',
      xdaiWei,
      amountSourceWei: xdaiWei / 4000n,
    })
  })

  it('produces an amount the payment screen can parse as a number', () => {
    // The dialog's breakdown rows do arithmetic on `amountFormatted`.
    const { amountFormatted } = quoteLocalPayment(request(parseEther('0.06')))
    expect(Number.isFinite(Number(amountFormatted))).toBe(true)
    expect(Number(amountFormatted)).toBeGreaterThan(0)
  })
})

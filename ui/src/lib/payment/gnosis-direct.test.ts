// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { parseUnits } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { quoteDirectPayment } from './gnosis-direct'

vi.mock('$lib/payment/postage-onchain', () => ({
  chainIdentity: () => Promise.resolve({ chainId: 100, isMainnet: true }),
  postageChain: () => Promise.resolve({}),
}))
vi.mock('$lib/stores/network-settings.svelte', () => ({
  networkSettingsStore: { gnosisRpcUrl: 'https://rpc.gnosischain.com' },
}))

function request(xdaiWei: bigint) {
  return {
    chainId: 100,
    currency: '0x0000000000000000000000000000000000000000',
    user: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    recipient: '0x1111111111111111111111111111111111111111',
    xdaiWei,
  }
}

describe('quoteDirectPayment', () => {
  it('charges exactly what has to arrive — nothing takes a cut', () => {
    // The whole point of the direct path: no bridge fee, no solver spread. A
    // quote larger than the delivery would mean one had crept back in.
    const xdaiWei = parseUnits('0.06', 18)
    const quote = quoteDirectPayment(request(xdaiWei))
    expect(quote.amountFormatted).toBe('0.06')
    expect((quote.handle as { xdaiWei: bigint }).xdaiWei).toBe(xdaiWei)
  })

  it('prices in dollars, because xDAI is one', () => {
    expect(quoteDirectPayment(request(parseUnits('1.5', 18))).amountUsd).toBe('1.50')
  })

  it('carries the recipient through to execution', () => {
    const { handle } = quoteDirectPayment(request(parseUnits('0.06', 18)))
    expect((handle as { recipient: string }).recipient).toBe(
      '0x1111111111111111111111111111111111111111',
    )
  })

  it('formats a small amount the way the pay screen renders it', () => {
    // Shares the rail contract's formatter, so it cannot drift from the
    // breakdown rows beneath it the way Relay's raw figure did.
    expect(quoteDirectPayment(request(parseUnits('0.0000434659', 18))).amountFormatted).toBe(
      '0.00004347',
    )
  })
})

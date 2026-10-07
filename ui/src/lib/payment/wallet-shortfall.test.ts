// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import { NATIVE_CURRENCY } from '$lib/payment/payment-rail'

import { shortfallMessage, walletShortfall } from './wallet-shortfall'

const USDC = '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83'
const XDAI_DECIMALS = 18
const USDC_DECIMALS = 6

/**
 * What the incident's wallet was asked for: a drive priced at a little over
 * four thousandths of an xDAI, from a wallet holding none on Gnosis at all.
 */
const INCIDENT_XDAI_WEI = 4_326_941_957_999_499n

/** Balances as the dialog keeps them: a missing entry is "no figure yet". */
function holding(figures: Record<string, bigint>) {
  return (currency: string): bigint | undefined => figures[currency]
}

/**
 * Whether the wallet is known not to hold what the payment will take. Only a
 * figure that has actually been read can say no: the dialog reads balances in
 * the background, and an unread one standing in as zero would block Pay for
 * every wallet whose read was merely slow.
 */
describe('walletShortfall', () => {
  it('finds nothing to say about a payment that charges nothing', () => {
    expect(walletShortfall([], holding({}))).toBeUndefined()
  })

  it('never blocks on a balance that has not been read', () => {
    expect(
      walletShortfall([{ currency: NATIVE_CURRENCY, amount: INCIDENT_XDAI_WEI }], holding({})),
    ).toBeUndefined()
  })

  it('lets through a wallet holding exactly what is charged, or more', () => {
    const charges = [{ currency: NATIVE_CURRENCY, amount: INCIDENT_XDAI_WEI }]
    expect(
      walletShortfall(charges, holding({ [NATIVE_CURRENCY]: INCIDENT_XDAI_WEI })),
    ).toBeUndefined()
    expect(
      walletShortfall(charges, holding({ [NATIVE_CURRENCY]: INCIDENT_XDAI_WEI + 1n })),
    ).toBeUndefined()
  })

  /** The wallet showed "Insufficient funds for gas" only after Pay; this is before it. */
  it('catches a wallet holding none of the asset it is charged in', () => {
    expect(
      walletShortfall(
        [{ currency: NATIVE_CURRENCY, amount: INCIDENT_XDAI_WEI }],
        holding({ [NATIVE_CURRENCY]: 0n }),
      ),
    ).toEqual({ currency: NATIVE_CURRENCY, needed: INCIDENT_XDAI_WEI, held: 0n })
  })

  /**
   * A token payment on Gnosis is two transfers, and either can be the one the
   * wallet cannot make. Plenty of USDC does not pay the xDAI gas leg.
   */
  it('names the leg that is short when another is covered', () => {
    const gas = parseUnits('0.005', XDAI_DECIMALS)
    expect(
      walletShortfall(
        [
          { currency: USDC, amount: 10_836_000n },
          { currency: NATIVE_CURRENCY, amount: gas },
        ],
        holding({ [USDC]: 50_000_000n, [NATIVE_CURRENCY]: gas - 1n }),
      ),
    ).toEqual({ currency: NATIVE_CURRENCY, needed: gas, held: gas - 1n })
  })
})

/**
 * What the pay screen says instead of letting the wallet say "insufficient
 * funds for gas" after the user has already committed.
 */
describe('shortfallMessage', () => {
  const XDAI_ON_GNOSIS = { symbol: 'xDAI', decimals: XDAI_DECIMALS, chainName: 'Gnosis Chain' }

  /** A zero is not a figure `displayAmount` will render, so it gets words. */
  it('says "no" for an empty wallet rather than rendering a blank amount', () => {
    expect(shortfallMessage({ ...XDAI_ON_GNOSIS, held: 0n, needed: INCIDENT_XDAI_WEI })).toBe(
      'Your wallet has no xDAI on Gnosis Chain, and this payment needs 0.004327 xDAI. Choose another chain or token, or add funds to this one.',
    )
  })

  it('names what the wallet does hold when it holds some', () => {
    expect(
      shortfallMessage({
        ...XDAI_ON_GNOSIS,
        held: parseUnits('0.001', XDAI_DECIMALS),
        needed: INCIDENT_XDAI_WEI,
      }),
    ).toBe(
      'Your wallet has 0.001 xDAI on Gnosis Chain, and this payment needs 0.004327 xDAI. Choose another chain or token, or add funds to this one.',
    )
  })

  it('formats each amount in the token’s own decimals', () => {
    expect(
      shortfallMessage({
        symbol: 'USDC',
        decimals: USDC_DECIMALS,
        chainName: 'Base',
        held: 2_500_000n,
        needed: 10_836_000n,
      }),
    ).toMatch(/has 2\.5 USDC on Base, and this payment needs 10\.84 USDC/)
  })
})

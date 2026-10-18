// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** Whether the connected wallet is known to be short of what a payment charges. */
import { formatUnits } from 'viem'

import { type PaymentQuote, type PaymentToken, displayAmount } from '$lib/payment/payment-rail'

/** A balance for display. Unlike a price, zero is a figure: `displayAmount` would blank it. */
export function formatBalance(value: bigint, decimals: number): string {
  return value === 0n ? '0' : displayAmount(formatUnits(value, decimals))
}

/**
 * The first charge the wallet is known not to cover, as one sentence, or ''.
 * A charge in an unlisted token, or one whose balance is not read yet, never blocks.
 */
export function shortfallMessage(
  charges: PaymentQuote['charges'],
  tokens: PaymentToken[],
  held: (currency: string) => bigint | undefined,
  chainName: string,
): string {
  for (const charge of charges) {
    const token = tokens.find((candidate) => candidate.address === charge.currency)
    const balance = held(charge.currency)
    if (token && balance !== undefined && balance < charge.amount) {
      const needed = displayAmount(formatUnits(charge.amount, token.decimals))
      return `Your wallet has ${formatBalance(balance, token.decimals)} ${token.symbol} on ${chainName}, and this payment needs ${needed} ${token.symbol}. Choose another chain or token, or add funds to this one.`
    }
  }
  return ''
}

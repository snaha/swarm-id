// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** Whether the connected wallet is known to be short of what a payment charges. */
import { type PaymentQuote, type PaymentToken, displayBalance } from '$lib/payment/payment-rail'

/**
 * The first charge the wallet is known not to cover, as one sentence, or ''.
 * It names the balance alone: the price is the headline above it, and a second
 * figure for it here would round differently. A charge in an unlisted token, or
 * one whose balance is not read yet, never blocks.
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
      return `Your wallet has ${displayBalance(balance, token.decimals)} ${token.symbol} on ${chainName}, not enough for this payment. Choose another chain or token, or add funds to this one.`
    }
  }
  return ''
}

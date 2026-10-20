// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** Whether the connected wallet is known to be short of what a payment charges. */
import { formatUnits } from 'viem'

import {
  AMOUNT_PRECISION_DIGITS,
  type PaymentQuote,
  type PaymentToken,
} from '$lib/payment/payment-rail'

/**
 * `value` cut to the digits a price shows, rounded up or down rather than to
 * nearest: a balance shown rounded up would claim money the wallet lacks, and a
 * need shown rounded down would leave a top-up of that figure short.
 */
function toPrecision(value: bigint, direction: 'up' | 'down'): bigint {
  const dropped = value.toString().length - AMOUNT_PRECISION_DIGITS
  if (dropped <= 0) {
    return value
  }
  const unit = 10n ** BigInt(dropped)
  const down = (value / unit) * unit
  return direction === 'up' && down !== value ? down + unit : down
}

/** A balance for display, rounded down. Unlike a price, zero is a figure: "0", not blank. */
export function formatBalance(value: bigint, decimals: number): string {
  return formatUnits(toPrecision(value, 'down'), decimals)
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
      const needed = formatUnits(toPrecision(charge.amount, 'up'), token.decimals)
      return `Your wallet has ${formatBalance(balance, token.decimals)} ${token.symbol} on ${chainName}, and this payment needs ${needed} ${token.symbol}. Choose another chain or token, or add funds to this one.`
    }
  }
  return ''
}

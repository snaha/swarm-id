// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Whether the connected wallet is known to be short of what a payment will
 * take, and how to say so.
 *
 * Checked before Pay rather than left to the wallet, because the wallet only
 * finds out once the user has committed, and then says it in its own terms —
 * "insufficient funds for gas" — about a chain the user may never have chosen.
 * The pay screen can say it first, in ours, while another chain or token is
 * still one click away.
 *
 * Pure on purpose: the dialog owns the balances and the quote, and this only
 * compares them, so the rule can be tested without a component.
 */
import { formatUnits } from 'viem'

import { type PaymentQuote, displayAmount } from '$lib/payment/payment-rail'

/** One asset the wallet cannot cover: what the payment takes, what it holds. */
export interface WalletShortfall {
  currency: string
  needed: bigint
  held: bigint
}

/**
 * The first charge the wallet is KNOWN not to cover, or undefined.
 *
 * A balance not yet read never blocks. The dialog reads balances in the
 * background, and a missing figure means "no figure yet": standing in for a
 * zero it would refuse Pay to every wallet whose read was merely slow or
 * failed — a worse outcome than the wallet's own refusal at signing, which is
 * what an unknown balance falls back to.
 *
 * @param held - what the wallet holds of `currency` on the selected chain, or
 *   undefined when that is not known.
 */
export function walletShortfall(
  charges: PaymentQuote['charges'],
  held: (currency: string) => bigint | undefined,
): WalletShortfall | undefined {
  for (const charge of charges) {
    const balance = held(charge.currency)
    if (balance !== undefined && balance < charge.amount) {
      return { currency: charge.currency, needed: charge.amount, held: balance }
    }
  }
  return undefined
}

/** What a shortfall is said in terms of: the asset as the picker names it, and where. */
export interface ShortfallWording {
  symbol: string
  decimals: number
  held: bigint
  needed: bigint
  chainName: string
}

/** An amount as the pay screen renders every other one. */
function formatAmount(value: bigint, decimals: number): string {
  return displayAmount(formatUnits(value, decimals))
}

/**
 * One sentence for the pay screen: what the wallet has, what the payment
 * needs, and what to do about it.
 *
 * An empty wallet is said in words. `displayAmount` renders zero as nothing —
 * right for a price, where zero means "not priced" — so "has  xDAI" is what a
 * formatted zero would read as.
 */
export function shortfallMessage({
  symbol,
  decimals,
  held,
  needed,
  chainName,
}: ShortfallWording): string {
  const holding = held === 0n ? `no ${symbol}` : `${formatAmount(held, decimals)} ${symbol}`
  return `Your wallet has ${holding} on ${chainName}, and this payment needs ${formatAmount(needed, decimals)} ${symbol}. Choose another chain or token, or add funds to this one.`
}

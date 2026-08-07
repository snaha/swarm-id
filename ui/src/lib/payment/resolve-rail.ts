// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Picking the rail a payment is carried by.
 *
 * Separate from `payment-rail.ts` on purpose: the contract module is a leaf, so
 * that the rails can import values from it (the native-currency sentinel) with
 * no risk of an initialisation cycle. This module is where knowing about every
 * rail is allowed.
 */
import { resolveLocalRail } from '$lib/payment/dev-funding'
import type { PaymentRail } from '$lib/payment/payment-rail'
import { chainIdentity } from '$lib/payment/postage-onchain'
import { relayRail } from '$lib/payment/relay'

/**
 * Which rail — if any — should carry this payment.
 *
 * Three conditions, and each matters:
 *
 * - **A production build always pays for real.** Whatever chain it is pointed
 *   at, a shipped bundle that faked a payment when an RPC blipped would be far
 *   worse than one that fails. What keeps the dev rail out of the shipped
 *   bundle is not this check — a dead branch does not remove a static import —
 *   but the build-time swap behind `$lib/payment/dev-funding`, where
 *   `resolveLocalRail` becomes a stub that answers undefined.
 * - **Gnosis mainnet always pays for real**, judged by genesis hash, since a
 *   dev chain reports mainnet's chain id on purpose. An unreachable RPC counts
 *   as "not mainnet" — nothing can be spent against a chain that is not
 *   answering.
 * - **Off mainnet, a rail exists only if the local source chain is up.**
 *   Without it there is nowhere to take a signature, so the caller funds
 *   silently from the faucet instead and the payment screens never open.
 *
 * @returns the rail to pay through, or undefined to fund from the faucet.
 */
export async function resolvePaymentRail(): Promise<PaymentRail | undefined> {
  if (!import.meta.env.DEV) {
    return relayRail
  }
  const identity = await chainIdentity().catch(() => undefined)
  if (identity?.isMainnet) {
    return relayRail
  }
  return resolveLocalRail()
}

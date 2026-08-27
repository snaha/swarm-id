// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Picking the rail a payment can be carried by.
 *
 * Separate from `payment-rail.ts` on purpose: the contract module is a leaf, so
 * that the rails can import values from it (the native-currency sentinel) with
 * no risk of an initialisation cycle. This module is where knowing about every
 * rail is allowed.
 */
import { resolveGnosisDirectRail } from '$lib/payment/gnosis-direct'
import type { PaymentRail } from '$lib/payment/payment-rail'

/**
 * Which rail — if any — this payment can be carried by.
 *
 * **Paying from Gnosis needs no bridge at all**: the destination IS the source,
 * so the wallet sends xDAI to the batch owner and the swap takes it from there.
 * Today it is the only one.
 *
 * Resolved rather than imported, because whether a rail exists is a question
 * about the wallet and the endpoint, not a constant: an endpoint that cannot be
 * PROVEN to be Gnosis is offered nothing, rather than a payment signed onto a
 * chain the destination has never heard of.
 *
 * @returns the rail to pay through, or undefined when there is none — which is
 *   an error at the funding seam, not a licence to conjure the money.
 */
export async function resolvePaymentRail(): Promise<PaymentRail | undefined> {
  return resolveGnosisDirectRail()
}

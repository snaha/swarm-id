// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The two ways a drive can be paid for, named once.
 *
 * Two screens offer this choice — the up-front one in `drive-add-dialog`, and
 * the method screen inside `payment-dialog` a payment lands on — and a user who
 * meets different words for the same route in each would reasonably read them
 * as different routes. The labels are also what the e2e suites click.
 *
 * Extend and resize list only the built-in engine: the widget's PostageStamp
 * ABI carries `createBatch` alone, so it can buy a drive and can neither extend
 * nor resize one.
 */
export type PaymentMethod = 'widget' | 'built-in'

export const WIDGET_LABEL = 'Pay with crypto (fund.bzz.limo)'
export const BUILT_IN_LABEL = 'Pay with crypto (built in, experimental)'

/** Why the size and lifespan on the form are only an estimate on this route. */
export const WIDGET_EXPLAINER =
  'fund.bzz.limo opens in a popup and picks the drive’s size and lifespan itself, so the ones on the form are only an estimate of what you will pay.'

/** What the built-in engine will ask for next, said before it is chosen. */
export const BUILT_IN_EXPLAINER =
  'Pay on Gnosis from a connected wallet. The price is quoted before anything is signed — and when an earlier attempt already left enough at the drive’s address, there is nothing left to pay.'

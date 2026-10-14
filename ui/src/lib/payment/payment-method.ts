// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { CARD_SHOP_AVAILABLE, CARD_SHOP_HOST, WIDGET_HOST } from '$lib/payment/multichain-widget'

/**
 * The ways a drive can be paid for, named once.
 *
 * Two screens offer this choice — the up-front one in `drive-add-dialog`, and
 * the method screen inside `payment-dialog` a payment lands on — and a user who
 * meets different words for the same route in each would reasonably read them
 * as different routes. The labels are also what the e2e suites click.
 *
 * Resize lists only the built-in engine. The widget's PostageStamp ABI carries
 * `createBatch` alone, so it can buy a drive and can neither extend nor resize
 * one. The card shop buys a drive, and extends one from its own treasury.
 */
export type PaymentMethod = 'widget' | 'card' | 'built-in'
/** What a caller can preselect on the payment screen: buying a drive chooses
 *  the card before the funding seam is ever reached, so never the card. */
export type FundingMethod = Exclude<PaymentMethod, 'card'>
/** Whether the chooser lists the card shop: no shop configured, no option. */
export const CARD_AVAILABLE = CARD_SHOP_AVAILABLE

export const WIDGET_LABEL = `Pay with crypto (${WIDGET_HOST})`
export const CARD_LABEL = `Pay with card (${CARD_SHOP_HOST})`
export const BUILT_IN_LABEL = 'Pay with crypto (built in, experimental)'
/** The button that hands the payment to the popup, the same from either dialog. */
export const WIDGET_CONTINUE_LABEL = `Continue to ${WIDGET_HOST}`
export const CARD_CONTINUE_LABEL = `Continue to ${CARD_SHOP_HOST}`

/** Why the size and lifespan on the form are only a starting point on this route. */
export const WIDGET_EXPLAINER = `${WIDGET_HOST} opens in a popup with the size and lifespan from the form as its defaults. Confirm or change them there — the drive gets what you buy in the popup.`

/** The card route: a storage purchase in euros or pounds, no token anywhere in it. */
export const CARD_EXPLAINER = `${CARD_SHOP_HOST} opens in a popup with the size and lifespan from the form filled in. Pay by card there — the drive gets what you buy in the popup.`

/** The card route for an extension: the shop tops the drive up itself. */
export const CARD_TOP_UP_EXPLAINER = `${CARD_SHOP_HOST} opens in a popup with this drive and the added lifespan filled in. Pay by card there — the shop extends the drive itself, and nothing is sent to your address.`

/** What the built-in engine will ask for next, said before it is chosen. */
export const BUILT_IN_EXPLAINER =
  'Pay on Gnosis from a connected wallet. The price is quoted before anything is signed — and when an earlier attempt already left enough at the drive’s address, there is nothing left to pay.'

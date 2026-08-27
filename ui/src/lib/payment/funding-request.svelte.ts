// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The dialogs' funding seam: turns a `FundingNeed` raised mid-operation into a
 * pending payment the UI surfaces, resolving once the money has landed.
 *
 * A rail is the only way to fund an operation; when none resolves, this throws.
 */
import type { FundingNeed, OperationStep, RequestFunding } from '$lib/payment/drive-operation'
import { type FundingQuote, swapDelivered } from '$lib/payment/funding'
import type { PaymentRail } from '$lib/payment/payment-rail'
import { resolvePaymentRail } from '$lib/payment/resolve-rail'
import type { Account } from '$lib/types'

/**
 * Human-readable label for the pending screen. The `paying` step is worded per
 * operation: one transaction extends a drive's lifespan, pays for a larger
 * size, or buys the drive outright, depending on which flow raised it.
 */
export function describeStep(
  step: OperationStep,
  operation: 'extend' | 'resize' | 'purchase',
): string {
  switch (step) {
    case 'checking':
      return operation === 'purchase' ? 'Checking the chain…' : 'Checking the drive on chain…'
    case 'funding':
      return 'Waiting for the payment…'
    case 'approving':
      return 'Approving the payment…'
    case 'paying':
      if (operation === 'purchase') {
        return 'Buying the drive…'
      }
      return operation === 'extend' ? 'Extending the lifespan…' : 'Paying for the larger size…'
    case 'resizing':
      return 'Increasing the drive size…'
    default:
      return 'Recording the change…'
  }
}

/**
 * The user backed out of paying. Typed so the dialogs can return to their form
 * instead of presenting a deliberate choice as a failure.
 */
export class PaymentCancelledError extends Error {
  constructor() {
    super('Payment cancelled.')
    this.name = 'PaymentCancelledError'
  }
}

/**
 * The user chose to pay through the fund.bzz.limo widget rather than the
 * built-in engine. Typed, and deliberately NOT a `PaymentCancelledError`: the
 * engine operation is abandoned with nothing spent, but the purchase is going
 * ahead by another route, and a dialog that read this as a cancel would drop
 * the user back on its form with no popup and no explanation.
 */
export class UseWidgetError extends Error {
  constructor() {
    super('Paying through fund.bzz.limo instead.')
    this.name = 'UseWidgetError'
  }
}

/**
 * A need awaiting payment, with the rail it would be paid through. Not the
 * quote: the default method needs none, so pricing is deferred to the screen
 * that chose the built-in engine rather than held in front of the dialog.
 */
export interface PendingPayment {
  need: FundingNeed
  rail: PaymentRail
}

/**
 * How a pending request is being abandoned. No options is the ordinary case:
 * the user backed out, or the dialog went away, with nothing signed.
 *
 * The three named ones are all about the window where a signature is with the
 * wallet and cannot be withdrawn. Which of them arrives decides whether the
 * operation ends, and how — so they are one discriminated choice rather than
 * flags a caller could set half of.
 */
export type CancelOptions =
  /**
   * The user cancelled with the source-chain transaction already handed to
   * their wallet. Not a clean cancel: the screens go away, the request keeps
   * waiting, and an approval that follows still settles the operation. From
   * here on a plain cancel — a closed dialog, an unmount — leaves it waiting
   * too, because nothing about those makes the payment stop.
   */
  | { reason: 'payment-in-flight' }
  /** That payment came back a wallet rejection: nothing was sent, so the
   * operation is let go rather than left waiting for a settlement that will
   * never come. */
  | { reason: 'wallet-rejected' }
  /**
   * That payment was broadcast and could not be confirmed. The money may well
   * be on its way, so this is not a cancel: the request fails with the rail's
   * own words, and the retry re-prices against whatever landed instead of
   * charging for it again.
   */
  | { reason: 'payment-unconfirmed'; error: Error }
  /**
   * The method screen handed the payment to the fund.bzz.limo widget. Nothing
   * is signed at that point — the seam is raised before any spend — so the
   * engine operation is let go, and the caller takes over from the widget.
   */
  | { reason: 'use-widget' }

export interface FundingRequester {
  /** The payment currently awaiting the user, or undefined. */
  readonly pending: PendingPayment | undefined
  /** Pass to `runExtend`/`runResize` as their funding seam. */
  request: RequestFunding
  /**
   * Called by the payment dialog once the source payment has settled, with the
   * quote that payment was finally made against — a failed attempt is re-priced
   * before the user pays again, and the swap must spend the figure the delivery
   * was sized for.
   */
  resolve: (settled: FundingQuote) => void
  /** Abandon a pending request (dialog closed / user cancelled). */
  cancel: (options?: CancelOptions) => void
}

export function createFundingRequester(account: () => Account): FundingRequester {
  // RAW, deliberately. Plain `$state` deep-proxies what it holds, and a
  // `PendingPayment` holds the rail — whose chain descriptors are handed
  // straight to the wallet. A wallet sits behind a postMessage bridge, so its
  // arguments are structured-cloned, and a Proxy cannot be cloned: the payment
  // died on `wallet_addEthereumChain` with "could not be cloned". Nothing here
  // mutates the value in place, only replaces it, so raw is also what it means.
  let pending = $state.raw<PendingPayment | undefined>(undefined)
  let settle: { resolve: (quote: FundingQuote) => void; reject: (error: Error) => void } | undefined
  // Whether a signature is with the wallet. Remembered here rather than left to
  // the screens, because the cancels that arrive afterwards come from elsewhere
  // — a closed drive dialog, an unmount — and none of them can call the wallet
  // back either.
  let paymentInFlight = false

  /** End the wait in failure, and forget that a payment was in flight. */
  const fail = (error: Error) => {
    paymentInFlight = false
    settle?.reject(error)
    settle = undefined
  }

  const request: RequestFunding = async (need) => {
    const rail = await resolvePaymentRail()
    if (!rail) {
      throw new Error('No payment route is available for this operation.')
    }
    paymentInFlight = false
    // Straight to the screens, unpriced. The default method is the widget,
    // which needs no quote of ours at all, so pricing the built-in rail here
    // would hold an empty dialog behind an RPC round-trip nobody had asked for
    // yet. The built-in path prices itself when it is chosen — including the
    // "already covered, nothing to pay" case, which it settles rather than
    // showing.
    pending = { need, rail }
    // Settles with the quote the payment was finally made against: the screens
    // re-price after a failed attempt, and the swap has to spend the figure
    // the delivery that actually happened was sized for.
    const quote = await new Promise<FundingQuote>((resolve, reject) => {
      settle = { resolve, reject }
    })
    // The rail delivered xDAI to the owner address; turn it into the BZZ the
    // operation needs. Not attempt-guarded — the payment already happened.
    await swapDelivered(account().derivationKey, quote)
  }

  return {
    get pending() {
      return pending
    },
    request,
    resolve(settled) {
      pending = undefined
      paymentInFlight = false
      settle?.resolve(settled)
      settle = undefined
    },
    cancel(options) {
      pending = undefined
      if (options === undefined) {
        // Nothing here can withdraw a prompt the wallet is showing, so while
        // one is up a plain cancel must not pretend otherwise: the screens go,
        // the request stays armed, and the payment's own outcome ends it. The
        // drive dialog shows "Waiting for the payment…" meanwhile.
        if (!paymentInFlight) {
          fail(new PaymentCancelledError())
        }
        return
      }
      switch (options.reason) {
        case 'payment-in-flight':
          // Screens away, request kept: the dialog hands the settlement on
          // even after this cancel, so an approval finishes and records the
          // operation instead of the money vanishing.
          paymentInFlight = true
          return
        case 'wallet-rejected':
          fail(new PaymentCancelledError())
          return
        case 'use-widget':
          fail(new UseWidgetError())
          return
        case 'payment-unconfirmed':
          fail(options.error)
      }
    },
  }
}

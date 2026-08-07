// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The dialogs' funding seam: turns a `FundingNeed` raised mid-operation into
 * either a pending payment the UI surfaces — resolving once the money has
 * landed — or, when there is no rail to pay through at all, a silent transfer
 * from the local faucet.
 */
import { fundFromFaucet } from '$lib/payment/dev-funding'
import type { FundingNeed, OperationStep, RequestFunding } from '$lib/payment/drive-operation'
import { type FundingQuote, quoteFunding, swapDeliveredXdai } from '$lib/payment/funding'
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
 * A need awaiting payment, with the rail it will be paid through and the
 * Gnosis-side quote it was priced from. All three travel as one so the payment
 * dialog is handed values it can rely on, rather than optionals it would have
 * to re-check — and so the quote the user pays for is the same object that is
 * later swapped, not an independently re-priced one that may have drifted.
 */
export interface PendingPayment {
  need: FundingNeed
  rail: PaymentRail
  quote: FundingQuote
}

export interface FundingRequester {
  /** The payment currently awaiting the user, or undefined. */
  readonly pending: PendingPayment | undefined
  /** Pass to `runExtend`/`runResize` as their funding seam. */
  request: RequestFunding
  /** Called by the payment dialog once the source payment has settled. */
  resolve: () => void
  /** Abandon a pending request (dialog closed / user cancelled). */
  cancel: () => void
}

export function createFundingRequester(account: () => Account): FundingRequester {
  let pending = $state<PendingPayment | undefined>(undefined)
  let settle: { resolve: () => void; reject: (error: Error) => void } | undefined

  const request: RequestFunding = async (need) => {
    const rail = await resolvePaymentRail()
    if (!rail) {
      // Nothing to pay through — a dev chain with no local source chain up. The
      // faucet stands in for the whole payment leg and the screens never open.
      // In a production build this is the stub, which throws: no rail there
      // means no route, not a free top-up.
      await fundFromFaucet(account().derivationKey, need)
      return
    }
    const quote = await quoteFunding(need)
    // Nothing left to collect: xDAI already at the owner address covers the
    // whole operation, so opening the payment screens would be asking the user
    // to pay zero. Fall through and swap what is already there.
    if (quote.xdaiWei > 0n) {
      pending = { need, rail, quote }
      await new Promise<void>((resolve, reject) => {
        settle = { resolve, reject }
      })
    }
    // The rail delivered xDAI to the owner address; turn it into the BZZ the
    // operation needs. Not attempt-guarded — the payment already happened.
    await swapDeliveredXdai(account().derivationKey, quote)
  }

  return {
    get pending() {
      return pending
    },
    request,
    resolve() {
      pending = undefined
      settle?.resolve()
      settle = undefined
    },
    cancel() {
      pending = undefined
      settle?.reject(new PaymentCancelledError())
      settle = undefined
    },
  }
}

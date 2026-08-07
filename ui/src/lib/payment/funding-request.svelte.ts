// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The dialogs' funding seam: turns a `FundingNeed` raised mid-operation into
 * either a pending payment the UI surfaces — resolving once the money has
 * landed — or, when there is no rail to pay through at all, a silent transfer
 * from the local faucet.
 */
import { DEV_XDAI_FUNDING, fundPostageSigner } from '$lib/dev/chain-funding'
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
 * A need awaiting payment, together with the rail it will be paid through.
 * The two travel as one so the payment dialog is handed a rail it can rely on,
 * rather than a possibly-absent one it would have to keep re-checking.
 */
export interface PendingPayment {
  need: FundingNeed
  rail: PaymentRail
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

/** Headroom on a computed need; out of a faucet the margin is free. */
const FUNDING_MARGIN = 2n

export function createFundingRequester(account: () => Account): FundingRequester {
  let pending = $state<PendingPayment | undefined>(undefined)
  let quote: FundingQuote | undefined
  let settle: { resolve: () => void; reject: (error: Error) => void } | undefined

  const request: RequestFunding = async (need) => {
    const rail = await resolvePaymentRail()
    if (!rail) {
      // Nothing to pay through — a dev chain with no local source chain up. The
      // faucet stands in for the whole payment leg and the screens never open.
      // Over-deliver: the need was computed from a chain read that is a block
      // or two old by the time the operation spends it, and a real payment
      // over-delivers too (a swap of a quoted amount, with slippage).
      await fundPostageSigner(account().derivationKey, {
        xdai: DEV_XDAI_FUNDING,
        bzzPlur: need.bzz * FUNDING_MARGIN,
      })
      return
    }
    quote = await quoteFunding(need)
    pending = { need, rail }
    await new Promise<void>((resolve, reject) => {
      settle = { resolve, reject }
    })
    // Relay delivered xDAI to the owner address; turn it into the BZZ the
    // operation needs. Not attempt-guarded — the payment already happened.
    if (quote) {
      await swapDeliveredXdai(account().derivationKey, quote)
    }
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
      settle?.reject(new Error('Payment cancelled.'))
      settle = undefined
    },
  }
}

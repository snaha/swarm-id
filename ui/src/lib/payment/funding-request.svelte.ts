// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The dialogs' funding seam: turns a `FundingNeed` raised mid-operation into
 * either a mocked local transfer (dev chain — no Relay, no DEX there) or a
 * pending payment the UI surfaces, resolving once the money has landed.
 */
import { DEV_XDAI_FUNDING, fundPostageSigner } from '$lib/dev/chain-funding'
import { simulatedPurchases } from '$lib/dev/simulate-purchase'
import type { FundingNeed, OperationStep, RequestFunding } from '$lib/payment/drive-operation'
import { type FundingQuote, quoteFunding, swapDeliveredXdai } from '$lib/payment/funding'
import type { Account } from '$lib/types'

/**
 * Human-readable label for the pending screen. The `paying` step is worded per
 * operation: the same top-up transaction extends a drive's lifespan in one
 * flow and pays for the larger size in the other.
 */
export function describeStep(step: OperationStep, operation: 'extend' | 'resize'): string {
  switch (step) {
    case 'checking':
      return 'Checking the drive on chain…'
    case 'funding':
      return 'Waiting for the payment…'
    case 'approving':
      return 'Approving the payment…'
    case 'paying':
      return operation === 'extend' ? 'Extending the lifespan…' : 'Paying for the larger size…'
    case 'resizing':
      return 'Increasing the drive size…'
    default:
      return 'Recording the change…'
  }
}

export interface FundingRequester {
  /** The need currently awaiting payment, or undefined. */
  readonly pending: FundingNeed | undefined
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
  let pending = $state<FundingNeed | undefined>(undefined)
  let quote: FundingQuote | undefined
  let settle: { resolve: () => void; reject: (error: Error) => void } | undefined

  const request: RequestFunding = async (need) => {
    // No Relay exists off mainnet, so the faucet stands in for the whole
    // payment leg there. See simulatedPurchases() for what decides it.
    if (await simulatedPurchases()) {
      // Over-deliver: the need was computed from a chain read that is a block
      // or two old by the time the operation spends it, and a real payment
      // over-delivers too (the widget swaps a quoted amount with slippage).
      await fundPostageSigner(account().derivationKey, {
        xdai: DEV_XDAI_FUNDING,
        bzzPlur: need.bzz * FUNDING_MARGIN,
      })
      return
    }
    quote = await quoteFunding(need)
    pending = need
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

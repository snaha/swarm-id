// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The dialogs' funding seam: turns a `FundingNeed` raised mid-operation into
 * either a mocked local transfer (dev chain — no Relay, no DEX there) or a
 * pending payment the UI surfaces, resolving once the money has landed.
 */
import { fundPostageSigner } from '$lib/dev/chain-funding'
import type { FundingNeed, OperationStep, RequestFunding } from '$lib/payment/drive-operation'
import { type FundingQuote, quoteFunding, swapDeliveredXdai } from '$lib/payment/funding'
import { chainIdentity } from '$lib/payment/postage-onchain'
import { devSettingsStore } from '$lib/stores/dev-settings.svelte'
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

export function createFundingRequester(account: () => Account): FundingRequester {
  let pending = $state<FundingNeed | undefined>(undefined)
  let quote: FundingQuote | undefined
  let settle: { resolve: () => void; reject: (error: Error) => void } | undefined

  const request: RequestFunding = async (need) => {
    // Dev chain: no Relay exists, so the chain's dev faucet stands in for the
    // whole payment leg and the BZZ arrives directly. The toggle alone is not
    // enough to authorise that — it says nothing about which chain is on the
    // other end, and a dev chain answers the same chain id as mainnet.
    if (devSettingsStore.data.mockStampEnabled) {
      if ((await chainIdentity()).isMainnet) {
        throw new Error(
          'Mock purchases are on, but the configured RPC is Gnosis mainnet. Point it at a dev chain, or turn the mock off and pay for real.',
        )
      }
      await fundPostageSigner(account().derivationKey, need.bzz)
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

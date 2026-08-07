// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * What `dev-funding.ts` becomes in a production build — see that file for why.
 *
 * Nothing here imports anything: being importless is the whole point, since it
 * is what lets Rollup leave the dev tree out of the shipped bundle. Both
 * answers are "there is no dev arrangement here", which is also true: a
 * production build resolves the Relay rail whatever chain it is pointed at, so
 * neither of these is ever reached.
 */
import type { FundingNeed } from '$lib/payment/drive-operation'
import type { PaymentRail } from '$lib/payment/payment-rail'

/** No local source chain exists in a shipped build. */
export function resolveLocalRail(): Promise<PaymentRail | undefined> {
  return Promise.resolve(undefined)
}

/** Nothing to declare to the wallet beyond the real chains. */
export const devWalletChains: Array<{
  id: string
  token: string
  label: string
  rpcUrl: string
}> = []

/**
 * Unreachable — `resolvePaymentRail` never returns undefined in a production
 * build, so nothing calls this. It fails loudly rather than silently doing
 * nothing, because a funding request that resolves without delivering funds
 * would look to the caller like a payment that succeeded.
 */
export function fundFromFaucet(_derivationKey: string, _need: FundingNeed): Promise<void> {
  return Promise.reject(new Error('No payment route is available for this operation.'))
}

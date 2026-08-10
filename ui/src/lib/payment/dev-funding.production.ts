// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * What `dev-funding.ts` becomes in a production build — see that file for why.
 *
 * Nothing here imports anything at runtime: being importless is the whole
 * point, since it is what lets Rollup leave the dev tree out of the shipped
 * bundle. Both answers are "there is no dev arrangement here", which is also
 * true: a production build resolves the Relay rail whatever chain it is pointed
 * at, so neither of these is ever reached.
 */
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

/** Mirrors `dev-funding.ts` — see there for why it is declared twice. */
export interface DevSourceChain {
  chainId: number
  defaultRpcUrl: string
  rpcUrl(): string
  saveRpcUrl(url: string): void
}

/**
 * No source chain in a shipped build, so no field for it and — the reason this
 * is a value and not a `import.meta.env.DEV` branch at the call site — no probe
 * of the developer-machine endpoint it would have lived at.
 */
export const devSourceChain: DevSourceChain | undefined = undefined

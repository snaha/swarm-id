// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The dev-only half of funding, gathered behind ONE import so a production
 * build can drop it whole.
 *
 * `vite.config.ts` aliases this module to `dev-funding.production.ts` for
 * `vite build`, so a shipped bundle's payment path never reaches the local
 * rail, the faucet, or the anvil cheat codes and dev private key underneath
 * them. An `import.meta.env.DEV` branch alone would NOT achieve that: the
 * imports are static and the modules they pull in have top-level side effects,
 * so Rollup keeps them however dead the branch is. Verified by grepping the
 * built assets, which is the only way to know.
 *
 * The `/dev` route imports the same helpers directly and keeps its own copy of
 * them in its chunk. That is deliberate — it is developer tooling, it is loaded
 * only when visited, and stripping it is a separate decision about whether that
 * page belongs in a deployment at all.
 *
 * Keep the two files' exports identical. They are typechecked independently,
 * so a drift shows up as a build failure rather than a runtime surprise.
 */
import { DEV_XDAI_FUNDING, fundPostageSigner } from '$lib/dev/chain-funding'
import {
  LOCAL_SOURCE_CHAIN_ID,
  LOCAL_SOURCE_RPC_URL,
  resolveLocalRail,
} from '$lib/dev/local-payment-rail'
import type { FundingNeed } from '$lib/payment/drive-operation'

export { resolveLocalRail }

/**
 * Extra chains to declare to web3-onboard, so it recognises the wallet's
 * network while a payment is rehearsed against the local source chain instead
 * of reporting an unsupported one. Empty in a production build.
 */
export const devWalletChains = [
  {
    id: `0x${LOCAL_SOURCE_CHAIN_ID.toString(16)}`,
    token: 'ETH',
    label: 'Local source chain',
    rpcUrl: LOCAL_SOURCE_RPC_URL,
  },
]

/** Headroom on a computed need; out of a faucet the margin is free. */
const FUNDING_MARGIN = 2n

/**
 * Stand in for the whole payment leg with a faucet transfer — what happens on
 * a dev chain with no local source chain running, where there is nothing to
 * take a signature on.
 *
 * Over-delivers on purpose: the need was computed from a chain read that is a
 * block or two old by the time the operation spends it, and a real payment
 * over-delivers too (a swap of a quoted amount, with slippage).
 */
export async function fundFromFaucet(derivationKey: string, need: FundingNeed): Promise<void> {
  await fundPostageSigner(derivationKey, {
    xdai: DEV_XDAI_FUNDING,
    bzzPlur: need.bzz * FUNDING_MARGIN,
  })
}

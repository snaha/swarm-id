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
import {
  DEFAULT_SOURCE_RPC_URL,
  LOCAL_SOURCE_CHAIN_ID,
  SOURCE_RPC_OVERRIDE_KEY,
  localSourceRpcUrl,
  resolveLocalRail,
} from '$lib/dev/local-payment-rail'

export { resolveLocalRail }

/**
 * The dev payment source chain, as the network settings panel needs it.
 *
 * Declared in both halves of the seam rather than shared from one, which is
 * what the seam is: the production half must import nothing.
 */
export interface DevSourceChain {
  chainId: number
  defaultRpcUrl: string
  /** The endpoint in force, override included — read per access, not cached. */
  rpcUrl(): string
  /** Persist an override for it. */
  saveRpcUrl(url: string): void
}

/**
 * One value rather than four constants, because `undefined` is then the whole
 * answer for a production build: the settings dialog branches on its presence
 * instead of on `import.meta.env.DEV`. That is what stops a shipped page
 * probing `localhost` for a chain that only ever exists on a developer's
 * machine — a dead `import.meta.env.DEV` branch still runs the probe if the
 * value it needs was imported unconditionally.
 */
export const devSourceChain: DevSourceChain | undefined = {
  chainId: LOCAL_SOURCE_CHAIN_ID,
  defaultRpcUrl: DEFAULT_SOURCE_RPC_URL,
  rpcUrl: localSourceRpcUrl,
  saveRpcUrl: (url) => localStorage.setItem(SOURCE_RPC_OVERRIDE_KEY, url),
}

/**
 * Extra chains to declare to web3-onboard, so it recognises the wallet's
 * network while a payment is rehearsed against the local source chain instead
 * of reporting an unsupported one. Empty in a production build.
 */
export const devWalletChains = [
  {
    id: `0x${LOCAL_SOURCE_CHAIN_ID.toString(16)}`,
    token: 'ETH',
    label: 'Ethereum Mainnet (fake)',
    rpcUrl: localSourceRpcUrl(),
  },
]

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * What `onboard.ts` needs to offer WalletConnect, or `undefined` where this
 * build has no project id to offer it with.
 *
 * Split out so the decision can be tested apart from the browser library.
 * `onboard.ts` builds its Onboard instance at import, and
 * `@web3-onboard/walletconnect` THROWS on a missing project id rather than
 * degrading — so a build without one must not reach that call at all. The throw
 * would land while the module initialises, taking down every page that can
 * connect a wallet, including the ones with nothing to do with paying.
 */
import type { Chain } from 'viem'

/**
 * The project the app connects with unless a build overrides it — committed on
 * purpose, and empty until one is registered.
 *
 * A Reown project id is not a secret. SvelteKit bakes every `PUBLIC_*` var into
 * the client bundle, so whatever is configured ships to anyone who opens the
 * page; withholding it from the repo protects nothing. What actually guards the
 * project is its origin allowlist — the relay answers 403 to a request from an
 * origin the project does not name — so a committed id cannot be pointed at
 * someone else's site. Keeping it out of the repo would instead cost a setup
 * step on every dev machine and a configured value in every deployment, which
 * is how a picker silently ends up injected-only in one of them.
 *
 * Same shape as `busSignalingUrl` in `$lib/bus-signaling-url`: a committed
 * default with the environment able to override it.
 *
 * Empty leaves the picker injected-only, rather than offering a WalletConnect
 * that cannot complete a connection.
 */
export const DEFAULT_PROJECT_ID = ''

/**
 * The options we pass, declared here rather than imported.
 *
 * `@web3-onboard/walletconnect` does not export its own `WalletConnectOptions`
 * (its `index.d.ts` imports the name from an unresolvable `'types.js'`), so
 * both importing it and deriving it from the default export's parameter yield
 * `any` — which would type-check a misspelled key. A local declaration of just
 * the fields we set restores that check on our side.
 */
export interface WalletConnectOptions {
  projectId: string
  dappUrl: string | undefined
  optionalChains: number[]
}

/**
 * Options for the WalletConnect module, or `undefined` for "do not register it".
 *
 * @param projectId Reown Cloud project id from `PUBLIC_WALLETCONNECT_PROJECT_ID`,
 *   overriding {@link DEFAULT_PROJECT_ID}. Blank or absent falls back to that;
 *   blank on both leaves the wallet picker injected-only, which is where it was
 *   before this existed.
 * @param dappUrl This origin. Some wallets (MetaMask among them) refuse a
 *   connection whose metadata carries no url, and the library falls back to
 *   `appMetadata.explore`, which we do not set.
 * @param chains Every chain a payment may be signed on.
 */
export function walletConnectOptions(
  projectId: string | undefined,
  dappUrl: string | undefined,
  chains: Chain[],
): WalletConnectOptions | undefined {
  const trimmed = projectId?.trim() || DEFAULT_PROJECT_ID.trim()
  if (!trimmed) {
    return undefined
  }
  return {
    projectId: trimmed,
    dappUrl,
    // Optional, and nothing required. A WalletConnect session is negotiated
    // once, for a fixed set of chains, and `wallet_switchEthereumChain` to a
    // chain outside it fails — so every chain a payment may be signed on has to
    // be named here, or it is unreachable for the life of the session.
    //
    // Required would be the stronger promise and is the wrong trade: a wallet
    // that cannot serve a REQUIRED chain refuses the session outright. Naming
    // Gnosis there would turn "this wallet has no Gnosis" into "this wallet
    // cannot connect", for someone who meant to pay from Base and would never
    // be asked to sign on Gnosis at all. Left optional, the wallet approves what
    // it has and a chain it declined fails later at the switch — where
    // `switchWalletChain` already offers it via `wallet_addEthereumChain` (an
    // optional method in this module) and says so in words if that is refused.
    optionalChains: chains.map((chain) => chain.id),
  }
}

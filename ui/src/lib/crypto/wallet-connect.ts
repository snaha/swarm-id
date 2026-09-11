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
 * The Reown project the app connects with unless a build overrides it,
 * committed on purpose.
 *
 * A project id is not a secret. SvelteKit bakes every `PUBLIC_*` var into the
 * client bundle, so whatever is configured ships to anyone who opens the page;
 * withholding it from the repo protects nothing, and would cost a setup step on
 * every dev machine and a configured value in every deployment — which is how a
 * picker silently ends up injected-only in one of them. Same shape as
 * `busSignalingUrl` in `$lib/bus-signaling-url`.
 *
 * What keeps a committed id from being someone else's free relay quota is the
 * allowlist on the Reown project, which must name every origin that serves this
 * app and nothing else. That is dashboard state this file cannot assert, so it
 * is the thing to re-check when an origin is added — a new deployment or a
 * developer on a port other than 5500 reads as a blank QR code rather than an
 * error ([#732](https://github.com/snaha/swarm-id/issues/732)).
 *
 * Empty is still handled: it leaves the picker injected-only rather than
 * offering a WalletConnect that cannot complete a connection.
 */
export const DEFAULT_PROJECT_ID = '26aa4608b06ec5ebd013b57900b550e6'

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

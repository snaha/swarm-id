// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Web3-Onboard instance for selecting and connecting a wallet.
 *
 * Using @web3-onboard (rather than a bare `window.ethereum`) lets the user pick
 * a wallet when several are installed — and lets a wallet that injects nothing
 * be offered at all, which is the only kind some browsers have.
 */
import coinbaseModule from '@web3-onboard/coinbase'
import Onboard from '@web3-onboard/core'
import injectedModule from '@web3-onboard/injected-wallets'
import walletConnectModule from '@web3-onboard/walletconnect'

import { browser } from '$app/environment'
import { asset } from '$app/paths'

import { env } from '$env/dynamic/public'

import { SWARM_MARK_SVG } from '$lib/components/swarm-mark'
import { walletConnectOptions } from '$lib/crypto/wallet-connect'
import { devWalletChains } from '$lib/payment/dev-funding'
import { WALLET_CHAINS } from '$lib/payment/payment-rail'

const injected = injectedModule()
// WalletConnect, where the build has a project id for it. Injected wallets
// reach only browsers a wallet ships an extension for: Safari has neither
// MetaMask nor Coinbase Wallet, and on iOS there is no injected provider
// outside a wallet's own in-app browser, so without this the picker can be
// empty and the built-in payment method unreachable. WalletConnect needs
// nothing installed in the browser — a QR code on desktop, a deep link on
// mobile — so it is the route that exists everywhere.
//
// `dappUrl` is this origin rather than a configured one: it is what the wallet
// shows the user as who is asking, and a build serving several origins
// (deployments and per-PR previews alike) must name the one they are on.
const walletConnect = walletConnectOptions(
  env.PUBLIC_WALLETCONNECT_PROJECT_ID,
  browser ? window.location.origin : undefined,
  WALLET_CHAINS,
)
// Coinbase Wallet's own SDK, which like WalletConnect needs nothing installed:
// it reaches the phone app directly. Narrower than WalletConnect — one wallet,
// not any of them — so it is offered beside it rather than instead of it, and
// listed first because a named wallet is a clearer choice than a generic QR
// code to someone who has that wallet.
//
// `reloadOnDisconnect` is deprecated and the module reads it only to decide
// whether to warn, so passing it silences a deprecation warning that otherwise
// fires on every connect (it defaults to `true`, which trips the module's own
// check even when nothing is passed). `false` is also what this app would want
// if the option were still live: reloading the page out from under a disconnect
// would discard whatever dialog the user is in the middle of.
const coinbase = coinbaseModule({ supportedWalletType: 'all', reloadOnDisconnect: false })
const wallets = [injected, coinbase, ...(walletConnect ? [walletConnectModule(walletConnect)] : [])]
// Every chain onboard has to know about, or it reports the user's network as
// unsupported. That covers two different callers: `eth-wallet.ts`'s
// wallet-secured unlock, which only signs a plain message and stays on
// whichever network the wallet already happens to be on — Ethereum mainnet,
// the common default, which WALLET_CHAINS carries — and the payment flow
// (`payment-rail.ts`), which switches the wallet to WALLET_CHAINS to sign
// there. Each id exactly once: onboard rejects a duplicate outright, and it
// throws while this module initialises, which takes every page down with it.
const chains = [
  ...WALLET_CHAINS.map((chain) => ({
    id: `0x${chain.id.toString(16)}`,
    token: chain.nativeCurrency.symbol,
    label: chain.name,
    rpcUrl: chain.rpcUrls.default.http[0],
  })),
  // The local dev rail's source chain (`pnpm dev:source-chain`), so onboard
  // recognises the wallet's network when a payment is rehearsed against it
  // rather than reporting an unsupported chain. Empty in a production build —
  // via the seam rather than an `import.meta.env.DEV` branch here, because a
  // dead branch still leaves the import, and this module is loaded on every
  // page that can connect a wallet.
  ...devWalletChains,
]
const appMetadata = {
  name: 'Swarm ID',
  description: 'The identity system for Swarm',
  // Without an icon, onboard draws a question mark beside the wallet on its
  // "Connecting to …" screen. It renders the value inline when it is markup,
  // so the mark goes in as an SVG string rather than a URL.
  icon: SWARM_MARK_SVG,
  // WalletConnect sends both fields to the wallet as its `icons` array, which
  // takes URLs — the markup above is not one, so the approval sheet is branded
  // only from here, and only by a wallet that reads past the first entry. The
  // URL cannot go in `icon` instead: Coinbase base64s that field into a data
  // URI, and a URL there makes a broken one.
  logo: browser ? `${window.location.origin}${asset('/favicon.png')}` : undefined,
  recommendedInjectedWallets: [
    { name: 'Coinbase', url: 'https://wallet.coinbase.com/' },
    { name: 'MetaMask', url: 'https://metamask.io' },
  ],
}

export const onboard = Onboard({
  wallets,
  chains,
  appMetadata,
  connect: {
    showSidebar: false,
  },
  accountCenter: {
    desktop: {
      enabled: false,
    },
    mobile: {
      enabled: true,
    },
  },
})

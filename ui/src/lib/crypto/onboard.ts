// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Web3-Onboard instance for selecting and connecting an injected wallet.
 *
 * Using @web3-onboard (rather than a bare `window.ethereum`) lets the user pick
 * a wallet when several are installed.
 */
import Onboard from '@web3-onboard/core'
import injectedModule from '@web3-onboard/injected-wallets'

import { devWalletChains } from '$lib/payment/dev-funding'

const injected = injectedModule()
const wallets = [injected]
const chains = [
  {
    id: '0x1',
    token: 'ETH',
    label: 'Ethereum Mainnet',
    // We don't need RPC — there are no blockchain transactions.
    rpcUrl: 'https://swarm-id.snaha.net',
  },
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

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

import { LOCAL_SOURCE_CHAIN_ID, LOCAL_SOURCE_RPC_URL } from '$lib/dev/local-payment-rail'

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
  // The local dev rail's source chain (`pnpm dev:source-chain`). Declared so
  // onboard recognises the wallet's network when a payment is rehearsed against
  // it, rather than reporting an unsupported chain. Dev builds only — the
  // production bundle never offers this rail.
  ...(import.meta.env.DEV
    ? [
        {
          id: `0x${LOCAL_SOURCE_CHAIN_ID.toString(16)}`,
          token: 'ETH',
          label: 'Local source chain',
          rpcUrl: LOCAL_SOURCE_RPC_URL,
        },
      ]
    : []),
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

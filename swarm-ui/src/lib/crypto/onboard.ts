// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Web3-Onboard instance for selecting and connecting an injected wallet.
 *
 * Using @web3-onboard (rather than a bare `window.ethereum`) lets the user pick
 * a wallet when several are installed. Recovered from the pre-migration
 * `swarm-ui/src/lib/ethereum.ts` setup.
 */

import Onboard from '@web3-onboard/core'
import injectedModule from '@web3-onboard/injected-wallets'

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

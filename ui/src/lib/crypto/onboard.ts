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

import { WALLET_CHAINS } from '$lib/payment/payment-rail'

const injected = injectedModule()
const wallets = [injected]
// Every chain a payment can be signed on. Declaring them is what stops onboard
// reporting the user's network as unsupported once they switch to pay.
const chains = WALLET_CHAINS.map((chain) => ({
  id: `0x${chain.id.toString(16)}`,
  token: chain.nativeCurrency.symbol,
  label: chain.name,
  rpcUrl: chain.rpcUrls.default.http[0],
}))
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

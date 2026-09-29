// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The Coinbase Wallet SDK (4.x) remembers which signer the user picked — the
 * Smart Wallet (`scw`), the mobile app (`walletlink`) or the extension — and a
 * new provider reuses it without asking, whatever `supportedWalletType` says.
 * Only a disconnect clears it. So once a Smart Wallet has paid on this origin,
 * an EOA-only Coinbase module would quietly reconnect the Smart Wallet.
 */

/** Where `@coinbase/wallet-sdk` keeps the choice: `ScopedLocalStorage('CBWSDK', 'SignerConfigurator')`. */
export const COINBASE_SIGNER_TYPE_KEY = '-CBWSDK:SignerConfigurator:SignerType'
const SMART_WALLET_SIGNER = 'scw'

/**
 * Forget a saved Smart Wallet choice, so the next Coinbase connect shows its
 * signer selection again. An EOA choice is kept: it is what the access flow wants.
 */
export function forgetCoinbaseSmartWallet(storage: Pick<Storage, 'getItem' | 'removeItem'>): void {
  if (storage.getItem(COINBASE_SIGNER_TYPE_KEY) === SMART_WALLET_SIGNER) {
    storage.removeItem(COINBASE_SIGNER_TYPE_KEY)
  }
}

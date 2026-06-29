// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { HDNodeWallet, Mnemonic } from 'ethers'

import { hexToBytes } from '$lib/crypto/hex'

export interface DerivedWallet {
  /** 0x-prefixed Ethereum address — the account id. */
  address: string
  /** Compressed secp256k1 public key (0x-prefixed hex). */
  publicKey: string
  /** The BIP-39 entropy behind the phrase — this is what gets encrypted. */
  entropy: Uint8Array
}

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ')
}

export function isValidPhrase(phrase: string): boolean {
  return Mnemonic.isValidMnemonic(normalizePhrase(phrase))
}

export function walletFromPhrase(phrase: string): DerivedWallet {
  const mnemonic = Mnemonic.fromPhrase(normalizePhrase(phrase))
  const wallet = HDNodeWallet.fromMnemonic(mnemonic)
  return {
    address: wallet.address,
    publicKey: wallet.publicKey,
    entropy: hexToBytes(mnemonic.entropy),
  }
}

export function phraseFromEntropy(entropy: Uint8Array): string {
  return Mnemonic.fromEntropy(entropy).phrase
}

/** The account's signing key (0x-prefixed hex), derived on demand after unlock. */
export function privateKeyFromEntropy(entropy: Uint8Array): string {
  const mnemonic = Mnemonic.fromEntropy(entropy)
  return HDNodeWallet.fromMnemonic(mnemonic).privateKey
}

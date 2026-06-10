// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { HDNodeWallet, Mnemonic } from 'ethers'

import { hexToBytes } from '$lib/crypto/hex'

/** 16 bytes of entropy produce a 12-word BIP-39 phrase. */
const ENTROPY_LENGTH = 16

export interface DerivedWallet {
  /** 0x-prefixed Ethereum address — the account id. */
  address: string
  /** Compressed secp256k1 public key (0x-prefixed hex). */
  publicKey: string
  /** The BIP-39 entropy behind the phrase — this is what gets encrypted. */
  entropy: Uint8Array
}

export function generatePhrase(): string {
  const entropy = new Uint8Array(ENTROPY_LENGTH)
  crypto.getRandomValues(entropy)
  return Mnemonic.fromEntropy(entropy).phrase
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

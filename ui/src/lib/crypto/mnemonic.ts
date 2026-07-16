// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { hexToUint8Array } from '@snaha/swarm-id'
import { HDNodeWallet, Mnemonic } from 'ethers'

export interface DerivedWallet {
  /** 0x-prefixed Ethereum address — the account id. */
  address: string
  /** Compressed secp256k1 public key (0x-prefixed hex). */
  publicKey: string
  /** The signing key / master key (0x-prefixed hex). */
  privateKey: string
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
  return walletFromMnemonic(Mnemonic.fromPhrase(normalizePhrase(phrase)))
}

/** Rebuild the wallet from decrypted vault entropy (the sign-back-in path). */
export function walletFromEntropy(entropy: Uint8Array): DerivedWallet {
  return walletFromMnemonic(Mnemonic.fromEntropy(entropy))
}

function walletFromMnemonic(mnemonic: Mnemonic): DerivedWallet {
  const wallet = HDNodeWallet.fromMnemonic(mnemonic)
  return {
    address: wallet.address,
    publicKey: wallet.publicKey,
    privateKey: wallet.privateKey,
    entropy: hexToUint8Array(mnemonic.entropy),
  }
}

const PHRASE_ENTROPY_BYTES = 16 // 128 bits → a 12-word phrase

/**
 * Generate a random recovery phrase. Entropy-only — `Wallet.createRandom()`
 * would run a full EC key generation just to throw the wallet away.
 */
export function generatePhrase(): string {
  return phraseFromEntropy(crypto.getRandomValues(new Uint8Array(PHRASE_ENTROPY_BYTES)))
}

export function phraseFromEntropy(entropy: Uint8Array): string {
  return Mnemonic.fromEntropy(entropy).phrase
}

/** The account's signing key (0x-prefixed hex), derived on demand after unlock. */
export function privateKeyFromEntropy(entropy: Uint8Array): string {
  const mnemonic = Mnemonic.fromEntropy(entropy)
  return HDNodeWallet.fromMnemonic(mnemonic).privateKey
}

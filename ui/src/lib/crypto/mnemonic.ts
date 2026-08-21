// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39'
import { uint8ArrayToHex } from '@snaha/swarm-id'
import { english, mnemonicToAccount } from 'viem/accounts'

import { prefix0x } from '$lib/crypto/hex'

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
  return validateMnemonic(normalizePhrase(phrase), english)
}

export function walletFromPhrase(phrase: string): DerivedWallet {
  return walletFromNormalizedPhrase(normalizePhrase(phrase))
}

/** Rebuild the wallet from decrypted vault entropy (the sign-back-in path). */
export function walletFromEntropy(entropy: Uint8Array): DerivedWallet {
  return walletFromNormalizedPhrase(phraseFromEntropy(entropy))
}

/**
 * The account's keys at BIP-44's first Ethereum path, which is what
 * `mnemonicToAccount` derives by default.
 */
function walletFromNormalizedPhrase(phrase: string): DerivedWallet {
  const account = mnemonicToAccount(phrase)
  const hdKey = account.getHdKey()
  if (!hdKey.privateKey || !hdKey.publicKey) {
    throw new Error('The recovery phrase did not derive a key pair.')
  }
  return {
    address: account.address,
    publicKey: prefix0x(uint8ArrayToHex(hdKey.publicKey)),
    privateKey: prefix0x(uint8ArrayToHex(hdKey.privateKey)),
    entropy: mnemonicToEntropy(phrase, english),
  }
}

const PHRASE_ENTROPY_BYTES = 16 // 128 bits → a 12-word phrase

/** Generate a random recovery phrase. */
export function generatePhrase(): string {
  return phraseFromEntropy(crypto.getRandomValues(new Uint8Array(PHRASE_ENTROPY_BYTES)))
}

export function phraseFromEntropy(entropy: Uint8Array): string {
  return entropyToMnemonic(entropy, english)
}

/** The account's signing key (0x-prefixed hex), derived on demand after unlock. */
export function privateKeyFromEntropy(entropy: Uint8Array): string {
  return walletFromEntropy(entropy).privateKey
}

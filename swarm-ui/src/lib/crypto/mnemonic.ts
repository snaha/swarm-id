// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * BIP-39 mnemonic helpers. Copied (with swarm-ui style adjustments) from
 * `ui/src/lib/crypto/mnemonic.ts`.
 */
import { HDNodeWallet, Mnemonic } from 'ethers'

import { hexToBytes } from '$lib/crypto/hex'

/** 16 bytes of entropy produce a 12-word BIP-39 phrase. */
const ENTROPY_LENGTH = 16

export interface DerivedWallet {
  /** 0x-prefixed Ethereum address — the account id. */
  address: string
  /**
   * Compressed secp256k1 public key as BARE hex (no 0x) — the form the account
   * record stores (`CompressedPublicKeySchema` is 66 hex chars, no prefix).
   */
  publicKey: string
  /** The BIP-39 entropy behind the phrase — this is what gets encrypted. */
  entropy: Uint8Array
}

export function generatePhrase(): string {
  const entropy = new Uint8Array(ENTROPY_LENGTH)
  crypto.getRandomValues(entropy)
  return Mnemonic.fromEntropy(entropy).phrase
}

function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ')
}

export function walletFromPhrase(phrase: string): DerivedWallet {
  const mnemonic = Mnemonic.fromPhrase(normalizePhrase(phrase))
  const wallet = HDNodeWallet.fromMnemonic(mnemonic)
  return {
    address: wallet.address,
    // ethers returns the compressed key 0x-prefixed; strip it so the stored
    // value satisfies the lib's bare-hex `CompressedPublicKeySchema`.
    publicKey: wallet.publicKey.replace(/^0x/, ''),
    entropy: hexToBytes(mnemonic.entropy),
  }
}

/** The account's signing key (0x-prefixed hex), derived on demand after unlock. */
export function privateKeyFromEntropy(entropy: Uint8Array): string {
  const mnemonic = Mnemonic.fromEntropy(entropy)
  return HDNodeWallet.fromMnemonic(mnemonic).privateKey
}

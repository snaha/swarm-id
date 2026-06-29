// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BIP39 seed-phrase validation helpers.
 *
 * Generic word-count + mnemonic validation shared by every phrase-entry UI
 * (create, import, and the re-enter-seed modal). These helpers concern the seed
 * phrase itself and are independent of how the resulting seed is then secured —
 * in the unified account model every account stores its seed under an `access`
 * method + `encryptedSeed` vault (e.g. a password-secured account).
 */

import { Mnemonic } from 'ethers'

export type SeedPhraseValidation = { valid: true; phrase: string } | { valid: false; error: string }

/**
 * Validates a BIP39 mnemonic seed phrase.
 * Accepts 12 or 24 word phrases.
 * Returns the normalized (trimmed, lowercased) phrase when valid.
 */
export function validateSeedPhrase(phrase: string): SeedPhraseValidation {
  const trimmed = phrase.trim()

  if (!trimmed) {
    return { valid: false, error: 'Please enter your seed phrase' }
  }

  const normalized = trimmed.toLowerCase()
  const words = normalized.split(/\s+/)

  // Check word count
  if (words.length !== 12 && words.length !== 24) {
    return {
      valid: false,
      error: `Invalid word count: ${words.length}. Must be 12 or 24 words.`,
    }
  }

  // Validate using ethers.js Mnemonic
  try {
    Mnemonic.fromPhrase(normalized)
    return { valid: true, phrase: normalized }
  } catch {
    return {
      valid: false,
      error: 'Invalid mnemonic phrase. Please check that all words are from the BIP39 wordlist.',
    }
  }
}

/**
 * Counts words in a seed phrase (for UI feedback)
 */
export function countSeedPhraseWords(phrase: string): number {
  const trimmed = phrase.trim()
  if (trimmed === '') return 0
  return trimmed.split(/\s+/).length
}

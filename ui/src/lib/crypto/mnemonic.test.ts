// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'

import { isValidPhrase, normalizePhrase, phraseFromEntropy, walletFromPhrase } from './mnemonic'

const KNOWN_PHRASE = 'test test test test test test test test test test test junk'
// Hardhat's well-known account #0 for the phrase above.
const KNOWN_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

describe('normalizePhrase', () => {
  it('collapses whitespace and lowercases', () => {
    expect(normalizePhrase('  Test  TEST\n test ')).toBe('test test test')
  })
})

describe('isValidPhrase', () => {
  it('accepts a known valid phrase', () => {
    expect(isValidPhrase(KNOWN_PHRASE)).toBe(true)
  })

  it('accepts a messy but valid phrase', () => {
    expect(isValidPhrase(`  ${KNOWN_PHRASE.toUpperCase().replace(/ /g, '   ')} `)).toBe(true)
  })

  it('rejects garbage', () => {
    expect(isValidPhrase('not a real phrase')).toBe(false)
    expect(isValidPhrase('')).toBe(false)
  })
})

describe('walletFromPhrase', () => {
  it('derives the expected address deterministically', () => {
    const wallet = walletFromPhrase(KNOWN_PHRASE)
    expect(wallet.address).toBe(KNOWN_ADDRESS)
    expect(wallet.publicKey.startsWith('0x')).toBe(true)
  })

  it('round-trips the phrase through its entropy', () => {
    const wallet = walletFromPhrase(KNOWN_PHRASE)
    expect(phraseFromEntropy(wallet.entropy)).toBe(KNOWN_PHRASE)
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end check that a real BIP-39 seed phrase, encrypted by the actual
 * create/import pipeline, produces an `encryptedSeed` the lib's
 * `AccountSchemaV1` accepts (and that the constraint rejects a blanked one).
 */
import { describe, it, expect } from 'vitest'
import { Mnemonic } from 'ethers'
import { AccountSchemaV1 } from '@snaha/swarm-id'
import { encryptSeed, deriveKeyFromPassword, randomSalt } from './encryption'
import { bytesToHex } from './hex'
import { generatePhrase, walletFromPhrase } from './mnemonic'

const PASSWORD = 'correct horse battery staple'
// PBKDF2 strength does not affect the encryptedSeed format (IV ‖ ciphertext),
// so use a low iteration count to keep the test fast.
const TEST_KDF_ITERATIONS = 1000

/** A real BIP-39 phrase: generatePhrase() yields 12 words; 24 needs 32B entropy. */
function realPhrase(words: 12 | 24): string {
  if (words === 12) return generatePhrase()
  return Mnemonic.fromEntropy(crypto.getRandomValues(new Uint8Array(32))).phrase
}

/** Encrypt a real phrase's entropy exactly as the password create/import flow does. */
async function encryptPhrase(phrase: string) {
  const { entropy } = walletFromPhrase(phrase)
  const salt = randomSalt()
  const key = await deriveKeyFromPassword(PASSWORD, salt, TEST_KDF_ITERATIONS)
  const encryptedSeed = await encryptSeed(entropy, key)
  return {
    encryptedSeed,
    access: {
      type: 'password' as const,
      kdfSalt: bytesToHex(salt),
      kdfIterations: TEST_KDF_ITERATIONS,
    },
  }
}

/** The serialized (wire) account shape AccountSchemaV1 parses, for a real wallet. */
function serializedAccount(phrase: string, vault: Awaited<ReturnType<typeof encryptPhrase>>) {
  const { address, publicKey } = walletFromPhrase(phrase)
  return {
    id: address.slice(2).toLowerCase(), // 40-char hex, no 0x prefix
    name: 'Test Account',
    createdAt: 1700000000000,
    derivationKey: 'f'.repeat(64),
    publicKey,
    access: vault.access,
    encryptedSeed: vault.encryptedSeed,
  }
}

describe('encryptedSeed from a real seed phrase', () => {
  it.each([
    [12, 88],
    [24, 120],
  ] as const)(
    'a real %i-word phrase encrypts to %i-char hex that AccountSchemaV1 accepts',
    async (words, expectedLength) => {
      const phrase = realPhrase(words)
      expect(phrase.split(' ')).toHaveLength(words)

      const vault = await encryptPhrase(phrase)
      expect(vault.encryptedSeed).toMatch(/^[0-9a-f]+$/)
      expect(vault.encryptedSeed).toHaveLength(expectedLength)

      expect(AccountSchemaV1.safeParse(serializedAccount(phrase, vault)).success).toBe(true)
    },
  )

  it('rejects a real account whose encryptedSeed is blanked', async () => {
    const phrase = generatePhrase()
    const account = serializedAccount(phrase, await encryptPhrase(phrase))
    expect(AccountSchemaV1.safeParse({ ...account, encryptedSeed: '' }).success).toBe(false)
  })
})

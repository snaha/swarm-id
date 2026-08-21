// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { hexToUint8Array } from '@snaha/swarm-id'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import {
  decryptSeed,
  deriveKeyFromPassword,
  deriveKeyFromPrf,
  deriveKeyFromSignature,
  encryptSeed,
  randomSalt,
} from './encryption'
import { canonicalSignature } from './signature'

// Fast KDF settings for tests only.
const TEST_ITERATIONS = 10

const ENTROPY = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])

describe('seed encryption round-trips', () => {
  it('with a password-derived key', async () => {
    const salt = randomSalt()
    const key = await deriveKeyFromPassword('correct horse battery staple', salt, TEST_ITERATIONS)
    const payload = await encryptSeed(ENTROPY, key)

    const sameKey = await deriveKeyFromPassword(
      'correct horse battery staple',
      salt,
      TEST_ITERATIONS,
    )
    expect(await decryptSeed(payload, sameKey)).toEqual(ENTROPY)
  })

  it('fails with the wrong password', async () => {
    const salt = randomSalt()
    const key = await deriveKeyFromPassword('right password', salt, TEST_ITERATIONS)
    const payload = await encryptSeed(ENTROPY, key)

    const wrongKey = await deriveKeyFromPassword('wrong password', salt, TEST_ITERATIONS)
    await expect(decryptSeed(payload, wrongKey)).rejects.toThrow()
  })

  it('with a PRF-derived key', async () => {
    const prfOutput = new Uint8Array(32).fill(7)
    const key = await deriveKeyFromPrf(prfOutput)
    const payload = await encryptSeed(ENTROPY, key)
    expect(await decryptSeed(payload, await deriveKeyFromPrf(prfOutput))).toEqual(ENTROPY)
  })

  it('with a wallet-signature-derived key', async () => {
    const wallet = privateKeyToAccount(generatePrivateKey())
    const message = 'sign to encrypt'
    const salt = randomSalt()

    // Deterministic ECDSA: signing the same message again yields the same key.
    const signature = canonicalSignature(await wallet.signMessage({ message }))
    const reSignature = canonicalSignature(await wallet.signMessage({ message }))
    expect(reSignature).toBe(signature)

    const key = await deriveKeyFromSignature(hexToUint8Array(signature), salt)
    const payload = await encryptSeed(ENTROPY, key)
    expect(
      await decryptSeed(payload, await deriveKeyFromSignature(hexToUint8Array(reSignature), salt)),
    ).toEqual(ENTROPY)
  })

  it('produces different ciphertexts per encryption (fresh IV)', async () => {
    const key = await deriveKeyFromPrf(new Uint8Array(32).fill(1))
    expect(await encryptSeed(ENTROPY, key)).not.toBe(await encryptSeed(ENTROPY, key))
  })
})

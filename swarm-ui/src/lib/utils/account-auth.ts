// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Account authentication for the unified (single) account model.
 *
 * Every account is a BIP-39 seed account that stores its seed encrypted at rest
 * (`encryptedSeed`) under a required `access` method. The "master key" used
 * throughout swarm-ui (as `deriveSecret` / `deriveAccountDerivationKey` input)
 * is the account's secp256k1 private key, re-derived from the seed entropy on
 * unlock.
 *
 * How the seed is unlocked depends on the `access` method:
 * - `passkey`    → re-authenticate with WebAuthn, decrypt the seed.
 * - `eth-wallet` → re-sign the fixed message, decrypt the seed.
 * - `password`   → re-derive the key from the supplied password, decrypt the seed.
 */

import type { Account } from '$lib/types'
import type { AccessMethod } from '@snaha/swarm-id'
import { Bytes } from '@ethersphere/bee-js'
import {
  decryptSeed,
  deriveKeyFromPassword,
  encryptSeed,
  PBKDF2_ITERATIONS,
  randomSalt,
} from '$lib/crypto/encryption'
import { deriveWalletKey, requestWalletKeySource } from '$lib/crypto/eth-wallet'
import { bytesToHex, hexToBytes } from '$lib/crypto/hex'
import { authenticateWithPasskey } from '$lib/crypto/passkey'
import { privateKeyFromEntropy } from '$lib/crypto/mnemonic'

/** The account's private key (master key) as Bytes, from decrypted seed entropy. */
function masterKeyFromEntropy(entropy: Uint8Array): Bytes {
  return new Bytes(privateKeyFromEntropy(entropy))
}

/**
 * Secure BIP-39 entropy with a password so the account can carry the required
 * `access` + `encryptedSeed` vault. Used by phrase-based create/import flows
 * (e.g. the recovery-phrase create flow and backup import): the user already has
 * the recovery phrase in hand; the password just protects the stored copy on
 * this device. Re-entering the same password later (password access in
 * getMasterKeyFromAccount) unlocks the seed.
 */
export async function secureSeedWithPassword(
  entropy: Uint8Array,
  password: string,
): Promise<{ access: AccessMethod; encryptedSeed: string }> {
  const salt = randomSalt()
  const key = await deriveKeyFromPassword(password, salt, PBKDF2_ITERATIONS)
  const encryptedSeed = await encryptSeed(entropy, key)
  return {
    access: {
      type: 'password',
      kdfSalt: bytesToHex(salt),
      kdfIterations: PBKDF2_ITERATIONS,
    },
    encryptedSeed,
  }
}

/**
 * Retrieves the master key from an account by authenticating the user and
 * decrypting the stored seed.
 * - passkey access:    re-authenticate with WebAuthn, decrypt the seed.
 * - eth-wallet access: re-sign the fixed message, decrypt the seed.
 * - password access:   re-derive the key from `password` (required for this
 *                      access type — the caller must collect and pass it).
 */
export async function getMasterKeyFromAccount(account: Account, password?: string): Promise<Bytes> {
  const access = account.access

  let key: CryptoKey
  if (access.type === 'passkey') {
    key = (await authenticateWithPasskey(access.credentialId)).key
  } else if (access.type === 'eth-wallet') {
    const source = await requestWalletKeySource()
    key = await deriveWalletKey(source, hexToBytes(access.encryptionSalt))
  } else {
    if (!password) {
      throw new Error('Password required.')
    }
    key = await deriveKeyFromPassword(password, hexToBytes(access.kdfSalt), access.kdfIterations)
  }

  let entropy: Uint8Array
  try {
    entropy = await decryptSeed(account.encryptedSeed, key)
  } catch {
    throw new Error(
      access.type === 'password' ? 'Wrong password.' : 'Could not decrypt the account seed.',
    )
  }
  return masterKeyFromEntropy(entropy)
}

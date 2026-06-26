// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Account authentication for the unified (single) account model.
 *
 * Every account is a BIP-39 seed account. The "master key" used throughout
 * swarm-ui (as `deriveSecret` / `deriveAccountDerivationKey` input) is the
 * account's secp256k1 private key, re-derived from the seed entropy on unlock.
 *
 * How the seed is unlocked depends on the optional `access` method stored on the
 * account:
 * - `passkey`   → re-authenticate with WebAuthn, decrypt the seed.
 * - `eth-wallet`→ re-sign the fixed message, decrypt the seed.
 * - (no access) → phrase-only account: the seed is not stored, so the caller
 *   must collect the BIP-39 phrase (SeedPhraseRequiredError) and call
 *   getMasterKeyFromAgentAccount.
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
import { privateKeyFromEntropy, walletFromPhrase } from '$lib/crypto/mnemonic'

/**
 * Error thrown when an account holds no stored seed (no `access`/`encryptedSeed`)
 * and therefore needs the BIP-39 phrase re-entered. The caller should show a UI
 * to collect the seed phrase, then call getMasterKeyFromAgentAccount.
 */
export class SeedPhraseRequiredError extends Error {
  constructor(public readonly accountId: string) {
    super('Seed phrase required for account authentication')
    this.name = 'SeedPhraseRequiredError'
  }
}

/** The account's private key (master key) as Bytes, from decrypted seed entropy. */
function masterKeyFromEntropy(entropy: Uint8Array): Bytes {
  return new Bytes(privateKeyFromEntropy(entropy))
}

/**
 * Secure BIP-39 entropy with a password so the account can carry the required
 * `access` + `encryptedSeed` vault. Used by phrase-based create/import flows
 * (agent, backup import): the user already has the recovery phrase in hand; the
 * password just protects the stored copy on this device. Re-entering the same
 * password later (password access in getMasterKeyFromAccount) unlocks the seed.
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
 * Authenticates a phrase-only account with the provided seed phrase. Verifies
 * the derived address matches the stored account id, then returns the master key.
 * Use this after catching SeedPhraseRequiredError and collecting the seed phrase.
 */
export function getMasterKeyFromAgentAccount(account: Account, seedPhrase: string): Bytes {
  const wallet = walletFromPhrase(seedPhrase)
  if (wallet.address.toLowerCase().replace('0x', '') !== account.id.toHex().toLowerCase()) {
    throw new Error(
      'Seed phrase does not match this account. The derived address differs from the stored account address.',
    )
  }
  return masterKeyFromEntropy(wallet.entropy)
}

/**
 * Retrieves the master key from an account by authenticating the user.
 * - passkey access:    re-authenticate with WebAuthn, decrypt the seed.
 * - eth-wallet access: re-sign the fixed message, decrypt the seed.
 * - password access:   requires a password (not collected here) — caller must
 *                      supply one; without it this throws.
 * - no access:         throws SeedPhraseRequiredError — caller collects the
 *                      phrase and uses getMasterKeyFromAgentAccount.
 */
export async function getMasterKeyFromAccount(account: Account, password?: string): Promise<Bytes> {
  const access = account.access
  if (!access || !account.encryptedSeed) {
    throw new SeedPhraseRequiredError(account.id.toString())
  }

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

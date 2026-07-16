// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unlock — re-derive the seed-encryption key from the account's access method
 * and decrypt the BIP-39 entropy. Used by reveals (private key, recovery
 * phrase) and backup export.
 */
import { hexToUint8Array } from '@snaha/swarm-id'

import { decryptSeed, deriveKeyFromPassword } from '$lib/crypto/encryption'
import { deriveWalletKey, requestWalletKeySource } from '$lib/crypto/eth-wallet'
import { authenticateWithPasskey } from '$lib/crypto/passkey'
import type { Account } from '$lib/types'

/**
 * Decrypt the account's seed entropy. For password accounts the caller must
 * supply the password; passkey and wallet accounts prompt the authenticator
 * or wallet.
 */
export async function unlockAccount(account: Account, password?: string): Promise<Uint8Array> {
  // The vault survives a sign-out, so this works for signed-out accounts too —
  // that IS the sign-back-in ceremony.
  const { access, encryptedSeed } = account.vault

  let key: CryptoKey
  if (access.type === 'password') {
    if (!password) {
      throw new Error('Password required.')
    }
    key = await deriveKeyFromPassword(
      password,
      hexToUint8Array(access.kdfSalt),
      access.kdfIterations,
    )
  } else if (access.type === 'passkey') {
    key = (await authenticateWithPasskey(access.credentialId)).key
  } else {
    // No wallet-address check: the wrong wallet derives a different key and
    // simply fails to decrypt below (the account id already pins the address).
    const source = await requestWalletKeySource()
    key = await deriveWalletKey(source, hexToUint8Array(access.encryptionSalt))
  }

  try {
    return await decryptSeed(encryptedSeed, key)
  } catch {
    throw new Error(
      access.type === 'password' ? 'Wrong password.' : 'Could not decrypt the account seed.',
    )
  }
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unlock — re-derive the seed-encryption key from the account's access method
 * and decrypt the BIP-39 entropy. Used by reveals (private key, recovery
 * phrase) and backup export.
 */
import { decryptSeed, deriveKeyFromPassword } from '$lib/crypto/encryption'
import { deriveWalletKey, requestWalletKeySource } from '$lib/crypto/eth-wallet'
import { hexToBytes } from '$lib/crypto/hex'
import { authenticateWithPasskey } from '$lib/crypto/passkey'
import type { Account } from '$lib/types'

/**
 * Decrypt the account's seed entropy. For password accounts the caller must
 * supply the password; passkey and wallet accounts prompt the authenticator
 * or wallet.
 */
export async function unlockAccount(account: Account, password?: string): Promise<Uint8Array> {
  const access = account.access

  let key: CryptoKey
  if (access.type === 'password') {
    if (!password) {
      throw new Error('Password required.')
    }
    key = await deriveKeyFromPassword(password, hexToBytes(access.kdfSalt), access.kdfIterations)
  } else if (access.type === 'passkey') {
    key = (await authenticateWithPasskey(access.credentialId)).key
  } else {
    // No wallet-address check: the wrong wallet derives a different key and
    // simply fails to decrypt below (the account id already pins the address).
    const source = await requestWalletKeySource()
    key = await deriveWalletKey(source, hexToBytes(access.encryptionSalt))
  }

  try {
    return await decryptSeed(account.encryptedSeed, key)
  } catch {
    throw new Error(
      access.type === 'password' ? 'Wrong password.' : 'Could not decrypt the account seed.',
    )
  }
}

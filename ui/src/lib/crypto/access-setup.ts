// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Create a fresh access method and its seed-encryption key — the
 * passkey / wallet / password branching shared by the account-creation access
 * step and the change-method ceremony.
 */
import { type AccessMethod, uint8ArrayToHex } from '@snaha/swarm-id'

import { PASSWORD_KDF_ITERATIONS, deriveKeyFromPassword, randomSalt } from '$lib/crypto/encryption'
import { deriveWalletKey, requestWalletKeySource } from '$lib/crypto/eth-wallet'
import { createPasskeyKey } from '$lib/crypto/passkey'

export interface AccessSetup {
  access: AccessMethod
  key: CryptoKey
}

/**
 * Runs the ceremony for the chosen method: registers a passkey, prompts the
 * wallet, or derives from the password. `method` mirrors the access tabs'
 * value set; anything that is not `passkey`/`eth-wallet` is the password tab.
 */
export async function createAccess(
  method: string,
  options: { accountName: string; password: string; signal?: AbortSignal },
): Promise<AccessSetup> {
  if (method === 'passkey') {
    const passkey = await createPasskeyKey(options.accountName, options.signal)
    return { access: { type: 'passkey', credentialId: passkey.credentialId }, key: passkey.key }
  }
  if (method === 'eth-wallet') {
    const source = await requestWalletKeySource()
    const salt = randomSalt()
    return {
      access: { type: 'eth-wallet', encryptionSalt: uint8ArrayToHex(salt) },
      key: await deriveWalletKey(source, salt),
    }
  }
  const salt = randomSalt()
  return {
    access: {
      type: 'password',
      kdfSalt: uint8ArrayToHex(salt),
      kdfIterations: PASSWORD_KDF_ITERATIONS,
    },
    key: await deriveKeyFromPassword(options.password, salt),
  }
}

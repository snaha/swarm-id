// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Ethereum wallet access method (EIP-1193, no connection library). The user
 * signs a fixed message; the seed-encryption key is derived from the public
 * key recovered from that signature, so re-signing the same message on any
 * device unlocks the seed.
 */
import { SigningKey, getAddress, hashMessage } from 'ethers'

import { deriveKeyFromPublicKey } from '$lib/crypto/encryption'

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

const SIGNING_MESSAGE =
  'Swarm ID\n\nSign this message to encrypt your recovery phrase on this device.\n\nv1'

export interface WalletKeySource {
  walletAddress: string
  publicKey: string
}

function getProvider(): EthereumProvider {
  const provider = (window as { ethereum?: EthereumProvider }).ethereum
  if (!provider) {
    throw new Error('No Ethereum wallet detected. Install a browser wallet and try again.')
  }
  return provider
}

/** Connect the wallet and recover its public key from a message signature. */
export async function requestWalletKeySource(): Promise<WalletKeySource> {
  const provider = getProvider()

  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  const walletAddress = accounts[0]
  if (!walletAddress) {
    throw new Error('No wallet account available.')
  }

  const signature = (await provider.request({
    method: 'personal_sign',
    params: [SIGNING_MESSAGE, walletAddress],
  })) as string

  const publicKey = SigningKey.recoverPublicKey(hashMessage(SIGNING_MESSAGE), signature)
  return { walletAddress: getAddress(walletAddress), publicKey }
}

/** Derive the seed-encryption key for a wallet key source. */
export function deriveWalletKey(source: WalletKeySource, salt: Uint8Array): Promise<CryptoKey> {
  return deriveKeyFromPublicKey(source.publicKey, salt)
}

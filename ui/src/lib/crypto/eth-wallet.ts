// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Ethereum wallet access method (EIP-1193, no connection library). The user
 * signs a fixed message; the seed-encryption key is derived from that
 * signature, so re-signing the same message with the same wallet unlocks the
 * seed. Only the wallet holder can produce the signature — the stored salt
 * and address alone reveal nothing.
 *
 * Relies on deterministic ECDSA (RFC 6979, standard in wallets): the same
 * message and key must always produce the same signature. Smart-contract
 * wallets (ERC-1271) don't return a recoverable ECDSA signature and are
 * rejected up front.
 */
import { Signature, getAddress, verifyMessage } from 'ethers'

import { deriveKeyFromSignature } from '$lib/crypto/encryption'
import { hexToBytes } from '$lib/crypto/hex'

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

const SIGNING_MESSAGE =
  'Swarm ID\n\nSign this message to encrypt your recovery phrase on this device.\n\nv1'

export interface WalletKeySource {
  walletAddress: string
  /** Canonical-serialized signature of SIGNING_MESSAGE — the secret key material. */
  signature: string
}

function getProvider(): EthereumProvider {
  const provider = (window as { ethereum?: EthereumProvider }).ethereum
  if (!provider) {
    throw new Error('No Ethereum wallet detected. Install a browser wallet and try again.')
  }
  return provider
}

/** Connect the wallet and obtain the deterministic message signature. */
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

  // Reject non-ECDSA signatures (smart-contract wallets) — they can't be
  // reproduced for key derivation — and normalize the representation so
  // unlock derives the same bytes as creation.
  if (getAddress(verifyMessage(SIGNING_MESSAGE, signature)) !== getAddress(walletAddress)) {
    throw new Error('This wallet type is not supported for securing an account.')
  }
  return {
    walletAddress: getAddress(walletAddress),
    signature: Signature.from(signature).serialized,
  }
}

/** Derive the seed-encryption key for a wallet key source. */
export function deriveWalletKey(source: WalletKeySource, salt: Uint8Array): Promise<CryptoKey> {
  return deriveKeyFromSignature(hexToBytes(source.signature), salt)
}

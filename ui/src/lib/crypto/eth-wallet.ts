// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Ethereum wallet access method (EIP-1193, connected via @web3-onboard so the
 * user can pick a wallet when several are installed). The user signs a fixed
 * message; the seed-encryption key is derived from that signature, so
 * re-signing the same message with the same wallet unlocks the seed. Only the
 * wallet holder can produce the signature — the stored salt and address alone
 * reveal nothing.
 *
 * Relies on deterministic ECDSA (RFC 6979, standard in wallets but not
 * enforced by any protocol): the same message and key must always produce the
 * same signature. Smart-contract wallets (ERC-1271) don't return a
 * recoverable ECDSA signature and are rejected up front; a random-nonce
 * signer would produce valid but ever-changing signatures, so minting new key
 * material signs twice and rejects the wallet on mismatch
 * (createWalletKeySource).
 */
import { hexToUint8Array } from '@snaha/swarm-id'
import { Signature, getAddress, verifyMessage } from 'ethers'

import { deriveKeyFromSignature } from '$lib/crypto/encryption'
import { onboard } from '$lib/crypto/onboard'

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

/**
 * Connect a wallet via @web3-onboard (so the user can pick one when several are
 * installed) and return its EIP-1193 provider plus the selected address.
 */
async function connectWallet(): Promise<{ provider: EthereumProvider; walletAddress: string }> {
  const connected = await onboard.connectWallet()
  const wallet = connected[0]
  if (!wallet) {
    throw new Error('No Ethereum wallet connected. Select a wallet and try again.')
  }

  const walletAddress = wallet.accounts[0]?.address
  if (!walletAddress) {
    throw new Error('No wallet account available.')
  }

  return { provider: wallet.provider as unknown as EthereumProvider, walletAddress }
}

/** Ask the wallet to personal_sign the fixed key-derivation message. */
async function signKeyMessage(provider: EthereumProvider, walletAddress: string): Promise<string> {
  return (await provider.request({
    method: 'personal_sign',
    params: [SIGNING_MESSAGE, walletAddress],
  })) as string
}

async function walletKeySource(
  provider: EthereumProvider,
  walletAddress: string,
): Promise<WalletKeySource> {
  const signature = await signKeyMessage(provider, walletAddress)

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

/**
 * Connect the wallet and obtain the deterministic message signature. Signs
 * once — for unlocking an existing account, where a signature that doesn't
 * reproduce the creation-time bytes merely fails decryption.
 */
export async function requestWalletKeySource(): Promise<WalletKeySource> {
  const { provider, walletAddress } = await connectWallet()
  return walletKeySource(provider, walletAddress)
}

/**
 * Connect the wallet and obtain the message signature for minting NEW key
 * material (account creation, unlock-method change). Deterministic signing is
 * a wallet convention, not a guarantee — a wallet signing with a random nonce
 * would derive a different key on every unlock and permanently lock the user
 * out. So before any seed is encrypted under the derived key, request a
 * second signature and require byte-identical canonical results.
 */
export async function createWalletKeySource(): Promise<WalletKeySource> {
  const { provider, walletAddress } = await connectWallet()
  const source = await walletKeySource(provider, walletAddress)

  const confirmation = await signKeyMessage(provider, walletAddress)
  if (Signature.from(confirmation).serialized !== source.signature) {
    throw new Error(
      'This wallet produces a different signature each time it signs, so it cannot reliably secure an account. Use a different wallet or unlock method.',
    )
  }
  return source
}

/** Derive the seed-encryption key for a wallet key source. */
export function deriveWalletKey(source: WalletKeySource, salt: Uint8Array): Promise<CryptoKey> {
  return deriveKeyFromSignature(hexToUint8Array(source.signature), salt)
}

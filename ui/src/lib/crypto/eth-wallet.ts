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
 * Relies on deterministic ECDSA (RFC 6979, standard in wallets): the same
 * message and key must always produce the same signature. Smart-contract
 * wallets (ERC-1271) don't return a recoverable ECDSA signature and are
 * rejected up front; a wallet that signs with a random nonce is caught at
 * enrollment, which asks for the signature twice and requires the same bytes.
 */
import { hexToUint8Array } from '@snaha/swarm-id'
import { type Hex, getAddress, recoverMessageAddress } from 'viem'

import { deriveKeyFromSignature } from '$lib/crypto/encryption'
import { connectAccessWallet } from '$lib/crypto/onboard'
import { canonicalSignature } from '$lib/crypto/signature'

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

const SIGNING_MESSAGE =
  'Swarm ID\n\nSign this message to encrypt your recovery phrase on this device.\n\nv1'

const UNSUPPORTED_WALLET = 'This wallet type is not supported for securing an account.'

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
  const connected = await connectAccessWallet()
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

/**
 * Sign SIGNING_MESSAGE and return its canonical form, refusing a signature that
 * does not recover to the wallet's own address (a smart-contract wallet).
 */
async function signKeyMessage(provider: EthereumProvider, walletAddress: string): Promise<Hex> {
  const signature = (await provider.request({
    method: 'personal_sign',
    params: [SIGNING_MESSAGE, walletAddress],
  })) as string

  // Every representation we know how to read is handled in `canonicalSignature`;
  // what is left throwing is a wallet whose output we genuinely cannot
  // reproduce, which is this flow's "not supported" — not viem's internals
  // ("Invalid yParityOrV value") shown to someone who only clicked Sign.
  let canonical
  try {
    canonical = canonicalSignature(signature)
  } catch {
    throw new Error(UNSUPPORTED_WALLET)
  }
  const signer = await recoverMessageAddress({ message: SIGNING_MESSAGE, signature: canonical })
  if (getAddress(signer) !== getAddress(walletAddress)) {
    throw new Error(UNSUPPORTED_WALLET)
  }
  return canonical
}

/**
 * Connect a wallet to secure an account with. Asks for the signature twice and
 * accepts the wallet only if both are the same bytes: one that signs with a
 * random nonce would derive a different key on every unlock.
 */
export async function enrollWalletKeySource(): Promise<WalletKeySource> {
  const { provider, walletAddress } = await connectWallet()
  const signature = await signKeyMessage(provider, walletAddress)
  const repeated = await signKeyMessage(provider, walletAddress)
  if (repeated !== signature) {
    throw new Error(
      'This wallet signs the same message differently each time, so it can’t be used to secure an account.',
    )
  }
  return { walletAddress: getAddress(walletAddress), signature }
}

/** Connect the wallet an account is secured with and sign once to re-derive its key. */
export async function unlockWalletKeySource(): Promise<WalletKeySource> {
  const { provider, walletAddress } = await connectWallet()
  const signature = await signKeyMessage(provider, walletAddress)
  return { walletAddress: getAddress(walletAddress), signature }
}

/** Derive the seed-encryption key for a wallet key source. */
export function deriveWalletKey(source: WalletKeySource, salt: Uint8Array): Promise<CryptoKey> {
  return deriveKeyFromSignature(hexToUint8Array(source.signature), salt)
}

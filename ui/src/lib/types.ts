// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The account is the aggregate root: it owns its postage stamps and connected
 * apps directly (nested), rather than referencing them across flat collections.
 * All values are plain JSON so the whole account serializes as-is.
 */

/** How the encrypted seed is unlocked on this device. */
export type AccessMethod =
  | { type: 'passkey'; credentialId: string }
  | { type: 'eth-wallet'; walletAddress: string; encryptionSalt: string }
  | { type: 'password'; kdfSalt: string; kdfIterations: number }

export interface PostageStamp {
  batchId: string
  signerKey: string
  depth: number
  amount: string
  bucketDepth: number
  blockNumber: number
  immutableFlag: boolean
  utilization: number
  usable: boolean
  exists: boolean
  batchTTL?: number
  createdAt: number
}

export interface ConnectedApp {
  appUrl: string
  appName: string
  appIcon?: string
  appDescription?: string
  lastConnectedAt: number
  connectedUntil?: number
}

export interface Account {
  /** 0x-prefixed Ethereum address derived from the recovery phrase. */
  id: string
  name: string
  /** Compressed secp256k1 public key (0x-prefixed hex). */
  publicKey: string
  createdAt: number
  access: AccessMethod
  /** BIP-39 entropy encrypted with the access-method key (hex: IV || ciphertext). */
  encryptedSeed: string
  /** How long app connections stay valid, in days. */
  appConnectionDays?: number
  defaultStampBatchId?: string
  stamps: PostageStamp[]
  connectedApps: ConnectedApp[]
}

/** The portable part of an account carried by sign-in sync and backup files. */
export type AccountData = Omit<Account, 'access' | 'encryptedSeed'>

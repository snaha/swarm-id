// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The account is the aggregate root: it owns its drives and connected apps
 * directly (nested), rather than referencing them across flat collections.
 * All values are plain JSON so the whole account serializes as-is.
 */

/** How the encrypted seed is unlocked on this device. */
export type AccessMethod =
  | { type: 'passkey'; credentialId: string }
  | { type: 'eth-wallet'; walletAddress: string; encryptionSalt: string }
  | { type: 'password'; kdfSalt: string; kdfIterations: number }

/**
 * A drive: an account's unit of owned Swarm storage, backed by a postage stamp
 * batch on the Bee node. Batch-level fields mirror the node's stamp object.
 */
export interface Drive {
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

/**
 * The portable part of an account — carried by sign-in sync and backup files.
 * Holds no device unlock secrets (access method / encrypted seed).
 */
export interface AccountData {
  /** 0x-prefixed Ethereum address derived from the recovery phrase. */
  id: string
  name: string
  /** Compressed secp256k1 public key (0x-prefixed hex). */
  publicKey: string
  createdAt: number
  /** How long app connections stay valid, in days. */
  appConnectionDays?: number
  defaultDriveBatchId?: string
  drives: Drive[]
  connectedApps: ConnectedApp[]
}

/** A full persisted account record: portable data plus this device's unlock secrets. */
export interface AccountRecord extends AccountData {
  access: AccessMethod
  /** BIP-39 entropy encrypted with the access-method key (hex: IV || ciphertext). */
  encryptedSeed: string
}

/**
 * The live account object the app works with: {@link AccountRecord} fields as
 * reactive state plus the mutation methods that own them. Defined with the
 * collection store and re-exported here so `$lib/types` stays the one type entry
 * point. Account-state changes are methods on the object (`account.addDrive(…)`),
 * never store calls that take an id and look the account up.
 */
export type { Account } from './stores/accounts.svelte'

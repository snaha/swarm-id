// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Swarm Identity - Key Derivation Utilities
 *
 * Provides cryptographic functions for deriving app-specific secrets
 * from a master identity key.
 */

import { PrivateKey } from "@ethersphere/bee-js"
import { hexToUint8Array, uint8ArrayToHex } from "./hex"

/**
 * Derive an app-specific secret from a master key and app origin
 *
 * Uses HMAC-SHA256 to create a deterministic, unique secret for each app.
 * The same master key + app origin will always produce the same secret.
 *
 * @param masterKey - The master identity key (hex string)
 * @param appOrigin - The app's origin (e.g., "https://swarm-app.local:8080")
 * @returns The derived secret as a hex string
 */
export async function deriveSecret(
  masterKey: string,
  appOrigin: string,
): Promise<string> {
  const encoder = new TextEncoder()

  // Convert master key from hex string to Uint8Array
  const keyData = hexToUint8Array(masterKey)
  const message = encoder.encode(appOrigin)

  // Import the master key for HMAC
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  // Sign the app origin with the master key
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, message)

  // Convert to hex string
  const secretHex = uint8ArrayToHex(new Uint8Array(signature))

  return secretHex
}

/**
 * Generate a random master key for testing/demo purposes
 *
 * In production, this would be derived from a user's mnemonic or
 * imported from an existing identity.
 *
 * @returns A random 32-byte key as a hex string
 */
export async function generateMasterKey(): Promise<string> {
  const randomBytes = new Uint8Array(32)
  crypto.getRandomValues(randomBytes)

  const masterKey = uint8ArrayToHex(randomBytes)

  return masterKey
}

// Re-export hex utilities for backwards compatibility
export { hexToUint8Array, uint8ArrayToHex } from "./hex"

/**
 * Verify that a derived secret matches the expected value
 *
 * Useful for testing.
 *
 * @param masterKey - Master key hex string
 * @param appOrigin - App origin
 * @param expectedSecret - Expected secret hex string
 * @returns true if the derived secret matches the expected secret
 */
export async function verifySecret(
  masterKey: string,
  appOrigin: string,
  expectedSecret: string,
): Promise<boolean> {
  const derived = await deriveSecret(masterKey, appOrigin)
  return derived === expectedSecret
}

/**
 * Derive account backup key from account master key
 *
 * Used for signing account feed updates
 *
 * @param accountMasterKey - Account master key (hex string)
 * @param accountId - Account ID (EthAddress hex string)
 * @returns 32-byte account backup key (as hex string)
 */
export async function deriveAccountBackupKey(
  accountMasterKey: string,
  accountId: string,
): Promise<string> {
  return deriveSecret(accountMasterKey, `account:${accountId}`)
}

/**
 * Derive account derivation key from account master key
 *
 * A generic 32-byte root key stored on the account, used for deterministically
 * deriving further keys (e.g. swarmEncryptionKey) without re-authentication.
 *
 * @param accountMasterKey - Account master key (hex string)
 * @returns 32-byte derivation key (as hex string)
 */
export async function deriveAccountDerivationKey(
  accountMasterKey: string,
): Promise<string> {
  return deriveSecret(accountMasterKey, `derivation-key`)
}

/**
 * Derive Swarm encryption key from account derivation key
 *
 * Used for encrypting account snapshot data before upload to Swarm.
 * Derived from the stored derivationKey rather than the master key directly.
 *
 * @param derivationKey - Account derivation key (hex string)
 * @returns 32-byte encryption key (as hex string)
 */
export async function deriveSwarmEncryptionKey(
  derivationKey: string,
): Promise<string> {
  return deriveSecret(derivationKey, `swarm-encryption`)
}

/**
 * Derive the account-level postage batch signer key from the account derivation
 * key. Used as the PrivateKey for signing chunks uploaded with a postage batch.
 *
 * @param derivationKey - Account derivation key (hex string)
 * @returns 32-byte signer key (as hex string)
 */
export async function derivePostageSignerKey(
  derivationKey: string,
): Promise<string> {
  return deriveSecret(derivationKey, `postage-signer`)
}

/**
 * Convert backup key to PrivateKey for feed signing
 */
export function backupKeyToPrivateKey(backupKeyHex: string): PrivateKey {
  return new PrivateKey(backupKeyHex)
}

// Export utility functions for testing
export const utils = {
  hexToUint8Array,
  uint8ArrayToHex,
}

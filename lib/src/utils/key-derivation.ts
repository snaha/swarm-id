// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Swarm Identity - Key Derivation Utilities
 *
 * Provides cryptographic functions for deriving app-specific secrets
 * from a master identity key.
 */

import { PrivateKey } from "@ethersphere/bee-js"
import { hmac } from "@noble/hashes/hmac"
import { sha256 } from "@noble/hashes/sha256"
import { hexToUint8Array, uint8ArrayToHex } from "./hex"

const SHARING_KEY_LABEL = new TextEncoder().encode("act-sharing")

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

// Re-export hex utilities for backwards compatibility
export { hexToUint8Array, uint8ArrayToHex } from "./hex"

/**
 * Derive an AES-GCM-256 key from `secretHex` under `context`.
 *
 * The three steps — HMAC to a fresh secret, hex to bytes, import as AES-GCM —
 * are one pipeline. Non-extractable and encrypt/decrypt only, which is the
 * part worth stating once (#590). The bus envelope (`deriveBusContext`) is the
 * live caller; the `.swarmid` file key is the identity UI's, derived by HKDF
 * from the recovery-phrase entropy, and never comes through here.
 */
export async function deriveAesGcmKey(
  secretHex: string,
  context: string,
): Promise<CryptoKey> {
  const keyHex = await deriveSecret(secretHex, context)
  return crypto.subtle.importKey(
    "raw",
    hexToUint8Array(keyHex),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  )
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
 * The account-wide ACT key (#519): what other people grant access to when they
 * mean the person rather than one of their apps. Derived from the derivation
 * key, so every app origin and every device of the account arrives at the same
 * key — and the master key still never leaves the identity UI. Its public half
 * is `identity.sharingPublicKey`.
 *
 * The same HMAC-SHA256 as `deriveSecret(derivationKey, "act-sharing")`, computed
 * synchronously with `@noble/hashes` because ConnectionInfo is built without
 * awaiting and `deriveSecret` still goes through Web Crypto. Once #692 makes the
 * derivation chain synchronous this becomes that one call — the test pins the
 * two equal so the swap cannot move the key.
 */
export function deriveSharingKey(derivationKey: string): {
  secret: Uint8Array
  publicKey: string
} {
  const secret = hmac(sha256, hexToUint8Array(derivationKey), SHARING_KEY_LABEL)
  return {
    secret,
    publicKey: new PrivateKey(secret).publicKey().toCompressedHex(),
  }
}

// Export utility functions for testing
export const utils = {
  hexToUint8Array,
  uint8ArrayToHex,
}

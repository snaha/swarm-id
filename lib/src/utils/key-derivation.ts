// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Swarm Identity - Key Derivation Utilities
 *
 * Every derived key is one HMAC-SHA256 of a parent key under a label:
 * `deriveSecret(parentKey, label)`. The labels below are the fixed points of
 * the derivation tree (docs-site: Key Derivation); an app secret uses the
 * app's origin as its label instead.
 */

import { PrivateKey } from "@ethersphere/bee-js"
import { hmac } from "@noble/hashes/hmac"
import { sha256 } from "@noble/hashes/sha256"
import { hexToUint8Array, uint8ArrayToHex } from "./hex"

// Re-export hex utilities for backwards compatibility
export { hexToUint8Array, uint8ArrayToHex } from "./hex"

/** Master key → the stored derivation key */
export const DERIVATION_KEY_LABEL = "derivation-key"
/** Derivation key → the Swarm encryption key */
export const SWARM_ENCRYPTION_LABEL = "swarm-encryption"
/** Derivation key → the postage signer that stamps the account's uploads */
export const POSTAGE_SIGNER_LABEL = "postage-signer"
/** Swarm encryption key → the backup signer that owns every feed */
export const BACKUP_KEY_LABEL = "backup-key"
/** Derivation key → the account-wide ACT sharing key (#519) */
export const ACT_SHARING_LABEL = "act-sharing"

/**
 * Derive a secret from a parent key under a label, with Web Crypto.
 *
 * HMAC-SHA256: deterministic, so the same parent key and label always give
 * the same secret. `deriveSecretSync` is the same function without the
 * `await`, for a caller that cannot have one; the test pins the two equal.
 *
 * @param parentKey - The key to derive from (hex string)
 * @param label - What the derived key is for: one of the labels above, or the
 *   app's origin (e.g. "https://swarm-app.local:8080") for a per-app secret
 * @returns The derived secret as a hex string
 */
export async function deriveSecret(
  parentKey: string,
  label: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    hexToUint8Array(parentKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(label),
  )
  return uint8ArrayToHex(new Uint8Array(signature))
}

/**
 * `deriveSecret` without the `await`: the same HMAC-SHA256 computed with
 * `@noble/hashes`, for a caller that cannot await — `buildConnectionInfo` in
 * the proxy builds ConnectionInfo synchronously (#692). Byte-identical to the
 * Web Crypto path, which the test pins.
 */
export function deriveSecretSync(parentKey: string, label: string): string {
  return uint8ArrayToHex(
    hmac(sha256, hexToUint8Array(parentKey), new TextEncoder().encode(label)),
  )
}

/**
 * Derive an AES-GCM-256 key from `secretHex` under `label`.
 *
 * The three steps — HMAC to a fresh secret, hex to bytes, import as AES-GCM —
 * are one pipeline. Non-extractable and encrypt/decrypt only, which is the
 * part worth stating once (#590). The bus envelope (`deriveBusContext`) is the
 * live caller; the `.swarmid` file key is the identity UI's, derived by HKDF
 * from the recovery-phrase entropy, and never comes through here.
 */
export async function deriveAesGcmKey(
  secretHex: string,
  label: string,
): Promise<CryptoKey> {
  const keyHex = await deriveSecret(secretHex, label)
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
  return deriveSecret(accountMasterKey, DERIVATION_KEY_LABEL)
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
  return deriveSecret(derivationKey, SWARM_ENCRYPTION_LABEL)
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
  return deriveSecret(derivationKey, POSTAGE_SIGNER_LABEL)
}

/**
 * `derivePostageSignerKey` without the `await`, for the proxy's ConnectionInfo
 * (#815): the signer's address is what an app buys a batch for.
 */
export function derivePostageSignerKeySync(derivationKey: string): string {
  return deriveSecretSync(derivationKey, POSTAGE_SIGNER_LABEL)
}

/**
 * The account-wide ACT key (#519): what other people grant access to when they
 * mean the person rather than one of their apps. Derived from the derivation
 * key, so every app origin and every device of the account arrives at the same
 * key — and the master key still never leaves the identity UI. Its public half
 * is `identity.sharingPublicKey`. Synchronous because ConnectionInfo is built
 * without awaiting.
 */
export function deriveSharingKey(derivationKey: string): {
  secret: Uint8Array
  publicKey: string
} {
  const secret = hexToUint8Array(
    deriveSecretSync(derivationKey, ACT_SHARING_LABEL),
  )
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

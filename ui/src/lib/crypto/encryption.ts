// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Seed encryption at rest. The BIP-39 entropy is AES-GCM encrypted with a key
 * derived from the chosen access method (passkey PRF, wallet public key, or
 * password); the access method can always re-derive the key, so only the
 * ciphertext is persisted.
 */
import { bytesToHex, hexToBytes } from '$lib/crypto/hex'

const AES_GCM = 'AES-GCM'
const AES_KEY_BITS = 256
const IV_LENGTH = 12
const SALT_LENGTH = 32
const PBKDF2_ITERATIONS = 600_000

export function randomSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_LENGTH)
  crypto.getRandomValues(salt)
  return salt
}

/** Encrypt seed entropy; returns hex of IV || ciphertext. */
export async function encryptSeed(entropy: Uint8Array, key: CryptoKey): Promise<string> {
  const iv = new Uint8Array(IV_LENGTH)
  crypto.getRandomValues(iv)
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_GCM, iv: iv as BufferSource },
    key,
    entropy as BufferSource,
  )
  const payload = new Uint8Array(IV_LENGTH + ciphertext.byteLength)
  payload.set(iv)
  payload.set(new Uint8Array(ciphertext), IV_LENGTH)
  return bytesToHex(payload)
}

export async function decryptSeed(payloadHex: string, key: CryptoKey): Promise<Uint8Array> {
  const payload = hexToBytes(payloadHex)
  const iv = payload.slice(0, IV_LENGTH)
  const ciphertext = payload.slice(IV_LENGTH)
  const entropy = await crypto.subtle.decrypt(
    { name: AES_GCM, iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  )
  return new Uint8Array(entropy)
}

/** Derive the seed-encryption key from a passkey PRF output (HKDF). */
export async function deriveKeyFromPrf(prfOutput: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', prfOutput as BufferSource, 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: new TextEncoder().encode('swarm-id-seed-encryption-v1'),
    },
    ikm,
    { name: AES_GCM, length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Derive the seed-encryption key from a wallet public key + stored salt (HKDF). */
export async function deriveKeyFromPublicKey(
  publicKeyHex: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    'raw',
    hexToBytes(publicKeyHex) as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: new TextEncoder().encode('swarm-id-seed-encryption-v1'),
    },
    ikm,
    { name: AES_GCM, length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Derive the seed-encryption key from a password + stored salt (PBKDF2). */
export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    ikm,
    { name: AES_GCM, length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

export const PASSWORD_KDF_ITERATIONS = PBKDF2_ITERATIONS

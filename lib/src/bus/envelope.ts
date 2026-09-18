// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AES-GCM-256 envelope for the account-bus signaling transport: every payload
 * that crosses the relay is sealed under the bus encryption key from
 * `deriveBusContext`, so the signaling server only ever carries ciphertext.
 */

const IV_LENGTH_BYTES = 12

/**
 * Encrypt a plaintext string. Returns base64-encoded [IV (12 bytes) || ciphertext+tag].
 */
export async function encryptEnvelope(
  plaintext: string,
  key: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES))
  const encoded = new TextEncoder().encode(plaintext)

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  )

  const combined = new Uint8Array(iv.length + ciphertextBuffer.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertextBuffer), iv.length)

  return uint8ArrayToBase64(combined)
}

/**
 * Decrypt a base64-encoded [IV (12 bytes) || ciphertext+tag]. Throws on a wrong
 * key or a tampered payload, as AES-GCM does.
 */
export async function decryptEnvelope(
  ciphertextBase64: string,
  key: CryptoKey,
): Promise<string> {
  const combined = base64ToUint8Array(ciphertextBase64)
  const iv = combined.slice(0, IV_LENGTH_BYTES)
  const ciphertext = combined.slice(IV_LENGTH_BYTES)

  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  )

  return new TextDecoder().decode(plaintextBuffer)
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { secp256k1 } from "@noble/curves/secp256k1"
import { Binary } from "cafe-utility"

// Key derivation nonces
const LOOKUP_KEY_NONCE = 0x00
const ACCESS_KEY_DECRYPTION_NONCE = 0x01

// Size constants
const PRIVATE_KEY_SIZE = 32
const PUBLIC_KEY_COORD_SIZE = 32
const COMPRESSED_PUBLIC_KEY_SIZE = 33
const UNCOMPRESSED_PREFIX = 0x04
const KEY_SIZE = 32
const COUNTER_SIZE = 4

/**
 * Derive public key from private key
 */
export function publicKeyFromPrivate(privKey: Uint8Array): {
  x: Uint8Array
  y: Uint8Array
} {
  if (privKey.length !== PRIVATE_KEY_SIZE) {
    throw new Error(`Private key must be ${PRIVATE_KEY_SIZE} bytes`)
  }

  const point = secp256k1.getPublicKey(privKey, false)

  return {
    x: point.slice(1, 1 + PUBLIC_KEY_COORD_SIZE),
    y: point.slice(1 + PUBLIC_KEY_COORD_SIZE),
  }
}

/**
 * Compute ECDH shared secret (x-coordinate of shared point)
 *
 * The public key point is validated to be on secp256k1 (rejects off-curve
 * points and the point at infinity) before multiplying — feeding an
 * unvalidated point to scalar multiplication would enable an invalid-curve
 * attack on the private key.
 */
export function ecdhSharedSecret(
  privKey: Uint8Array,
  pubX: Uint8Array,
  pubY: Uint8Array,
): Uint8Array {
  if (privKey.length !== PRIVATE_KEY_SIZE) {
    throw new Error(`Private key must be ${PRIVATE_KEY_SIZE} bytes`)
  }
  if (
    pubX.length !== PUBLIC_KEY_COORD_SIZE ||
    pubY.length !== PUBLIC_KEY_COORD_SIZE
  ) {
    throw new Error(
      `Public key coordinates must be ${PUBLIC_KEY_COORD_SIZE} bytes each`,
    )
  }

  const pubKey = new Uint8Array(1 + 2 * PUBLIC_KEY_COORD_SIZE)
  pubKey[0] = UNCOMPRESSED_PREFIX
  pubKey.set(pubX, 1)
  pubKey.set(pubY, 1 + PUBLIC_KEY_COORD_SIZE)

  // getSharedSecret validates the point and rejects the point at infinity;
  // compressed output is prefix || x, so slice off the prefix byte
  return secp256k1.getSharedSecret(privKey, pubKey, true).slice(1)
}

/**
 * Derive lookup key and access key decryption key from ECDH shared secret
 */
export function deriveKeys(
  privKey: Uint8Array,
  pubX: Uint8Array,
  pubY: Uint8Array,
): { lookupKey: Uint8Array; accessKeyDecryptionKey: Uint8Array } {
  const sharedSecret = ecdhSharedSecret(privKey, pubX, pubY)

  // lookupKey = keccak256(sharedX || 0x00)
  const lookupKeyInput = new Uint8Array(sharedSecret.length + 1)
  lookupKeyInput.set(sharedSecret)
  lookupKeyInput[sharedSecret.length] = LOOKUP_KEY_NONCE
  const lookupKey = Binary.keccak256(lookupKeyInput)

  // accessKeyDecryptionKey = keccak256(sharedX || 0x01)
  const akdKeyInput = new Uint8Array(sharedSecret.length + 1)
  akdKeyInput.set(sharedSecret)
  akdKeyInput[sharedSecret.length] = ACCESS_KEY_DECRYPTION_NONCE
  const accessKeyDecryptionKey = Binary.keccak256(akdKeyInput)

  return { lookupKey, accessKeyDecryptionKey }
}

/**
 * Counter-mode encryption/decryption
 * Matches Bee's Go implementation (bee/pkg/encryption/encryption.go:134-168)
 * For each 32-byte block i: data[i] XOR keccak256(keccak256(key || uint32LE(i)))
 */
export function counterModeEncrypt(
  data: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_SIZE) {
    throw new Error(`Key must be ${KEY_SIZE} bytes`)
  }

  const result = new Uint8Array(data.length)
  const numBlocks = Math.ceil(data.length / KEY_SIZE)

  for (let i = 0; i < numBlocks; i++) {
    // Create counter input: key || uint32LE(i)
    // Must match Bee's Go implementation which uses binary.LittleEndian.PutUint32
    const counterInput = new Uint8Array(key.length + COUNTER_SIZE)
    counterInput.set(key)
    // LITTLE ENDIAN counter (matches Bee's binary.LittleEndian.PutUint32)
    counterInput[key.length] = i & 0xff
    counterInput[key.length + 1] = (i >> 8) & 0xff
    counterInput[key.length + 2] = (i >> 16) & 0xff
    counterInput[key.length + 3] = (i >> 24) & 0xff

    // First hash: keccak256(key || counter)
    const ctrHash = Binary.keccak256(counterInput)

    // Second hash for "selective disclosure" (matches Bee's implementation)
    const keyStream = Binary.keccak256(ctrHash)

    // XOR data block with keystream
    const blockStart = i * KEY_SIZE
    const blockEnd = Math.min(blockStart + KEY_SIZE, data.length)

    for (let j = blockStart; j < blockEnd; j++) {
      result[j] = data[j] ^ keyStream[j - blockStart]
    }
  }

  return result
}

/**
 * Counter-mode decryption (symmetric with encryption)
 */
export const counterModeDecrypt = counterModeEncrypt

/**
 * Parse compressed public key (33 bytes) to uncompressed coordinates
 */
export function publicKeyFromCompressed(compressed: Uint8Array): {
  x: Uint8Array
  y: Uint8Array
} {
  if (compressed.length !== COMPRESSED_PUBLIC_KEY_SIZE) {
    throw new Error(
      `Compressed public key must be ${COMPRESSED_PUBLIC_KEY_SIZE} bytes`,
    )
  }

  const prefix = compressed[0]
  if (prefix !== 0x02 && prefix !== 0x03) {
    throw new Error("Invalid compressed public key prefix")
  }

  // fromHex validates the point is on the curve (rejects x with no valid y)
  const point = secp256k1.ProjectivePoint.fromHex(compressed).toRawBytes(false)

  return {
    x: point.slice(1, 1 + PUBLIC_KEY_COORD_SIZE),
    y: point.slice(1 + PUBLIC_KEY_COORD_SIZE),
  }
}

/**
 * Compress public key to 33 bytes
 */
export function compressPublicKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  if (
    x.length !== PUBLIC_KEY_COORD_SIZE ||
    y.length !== PUBLIC_KEY_COORD_SIZE
  ) {
    throw new Error(
      `Public key coordinates must be ${PUBLIC_KEY_COORD_SIZE} bytes each`,
    )
  }

  const prefix = (y[y.length - 1] & 1) === 0 ? 0x02 : 0x03

  const result = new Uint8Array(COMPRESSED_PUBLIC_KEY_SIZE)
  result[0] = prefix
  result.set(x, 1)

  return result
}

/**
 * Generate a random 32-byte key using crypto.getRandomValues
 */
export function generateRandomKey(): Uint8Array {
  const key = new Uint8Array(KEY_SIZE)
  crypto.getRandomValues(key)
  return key
}

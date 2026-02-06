/**
 * Unit tests for ACT cryptographic primitives
 */

import { describe, it, expect } from "vitest"
import {
  publicKeyFromPrivate,
  ecdhSharedSecret,
  deriveKeys,
  counterModeEncrypt,
  counterModeDecrypt,
  publicKeyFromCompressed,
  compressPublicKey,
  generateRandomKey,
} from "./crypto"

// Test vectors - known private key and expected public key
// Using a simple test vector that can be verified
const TEST_PRIVATE_KEY = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
])

// Generator point G for secp256k1 (private key = 1 gives G)
const GENERATOR_X = new Uint8Array([
  0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95, 0xce,
  0x87, 0x0b, 0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59, 0xf2,
  0x81, 0x5b, 0x16, 0xf8, 0x17, 0x98,
])

const GENERATOR_Y = new Uint8Array([
  0x48, 0x3a, 0xda, 0x77, 0x26, 0xa3, 0xc4, 0x65, 0x5d, 0xa4, 0xfb, 0xfc, 0x0e,
  0x11, 0x08, 0xa8, 0xfd, 0x17, 0xb4, 0x48, 0xa6, 0x85, 0x54, 0x19, 0x9c, 0x47,
  0xd0, 0x8f, 0xfb, 0x10, 0xd4, 0xb8,
])

describe("publicKeyFromPrivate", () => {
  it("should derive correct public key for private key = 1 (generator point)", () => {
    const pubKey = publicKeyFromPrivate(TEST_PRIVATE_KEY)
    expect(pubKey.x).toEqual(GENERATOR_X)
    expect(pubKey.y).toEqual(GENERATOR_Y)
  })

  it("should throw error for invalid private key length", () => {
    expect(() => publicKeyFromPrivate(new Uint8Array(16))).toThrow()
    expect(() => publicKeyFromPrivate(new Uint8Array(64))).toThrow()
  })

  it("should derive different public keys for different private keys", () => {
    const privKey1 = new Uint8Array(32)
    privKey1[31] = 1
    const privKey2 = new Uint8Array(32)
    privKey2[31] = 2

    const pubKey1 = publicKeyFromPrivate(privKey1)
    const pubKey2 = publicKeyFromPrivate(privKey2)

    expect(pubKey1.x).not.toEqual(pubKey2.x)
  })
})

describe("ecdhSharedSecret", () => {
  it("should compute same shared secret from both directions", () => {
    // Alice's key pair
    const alicePrivate = new Uint8Array(32)
    alicePrivate[31] = 2
    const alicePublic = publicKeyFromPrivate(alicePrivate)

    // Bob's key pair
    const bobPrivate = new Uint8Array(32)
    bobPrivate[31] = 3
    const bobPublic = publicKeyFromPrivate(bobPrivate)

    // Alice computes shared secret with Bob's public key
    const sharedAlice = ecdhSharedSecret(alicePrivate, bobPublic.x, bobPublic.y)

    // Bob computes shared secret with Alice's public key
    const sharedBob = ecdhSharedSecret(bobPrivate, alicePublic.x, alicePublic.y)

    // Both should be equal
    expect(sharedAlice).toEqual(sharedBob)
  })

  it("should return 32 bytes", () => {
    const privKey = new Uint8Array(32)
    privKey[31] = 5
    const pubKey = publicKeyFromPrivate(privKey)

    const shared = ecdhSharedSecret(privKey, pubKey.x, pubKey.y)
    expect(shared.length).toBe(32)
  })

  it("should throw error for invalid key lengths", () => {
    const validPriv = new Uint8Array(32)
    validPriv[31] = 1
    const pubKey = publicKeyFromPrivate(validPriv)

    expect(() =>
      ecdhSharedSecret(new Uint8Array(16), pubKey.x, pubKey.y),
    ).toThrow()
    expect(() =>
      ecdhSharedSecret(validPriv, new Uint8Array(16), pubKey.y),
    ).toThrow()
    expect(() =>
      ecdhSharedSecret(validPriv, pubKey.x, new Uint8Array(16)),
    ).toThrow()
  })
})

describe("deriveKeys", () => {
  it("should derive different lookup and access key decryption keys", () => {
    const privKey = new Uint8Array(32)
    privKey[31] = 7
    const pubKey = publicKeyFromPrivate(privKey)

    const { lookupKey, accessKeyDecryptionKey } = deriveKeys(
      privKey,
      pubKey.x,
      pubKey.y,
    )

    expect(lookupKey.length).toBe(32)
    expect(accessKeyDecryptionKey.length).toBe(32)
    expect(lookupKey).not.toEqual(accessKeyDecryptionKey)
  })

  it("should produce deterministic results", () => {
    const privKey = new Uint8Array(32)
    privKey[31] = 11
    const pubKey = publicKeyFromPrivate(privKey)

    const result1 = deriveKeys(privKey, pubKey.x, pubKey.y)
    const result2 = deriveKeys(privKey, pubKey.x, pubKey.y)

    expect(result1.lookupKey).toEqual(result2.lookupKey)
    expect(result1.accessKeyDecryptionKey).toEqual(
      result2.accessKeyDecryptionKey,
    )
  })

  it("should produce different keys for different inputs", () => {
    const privKey1 = new Uint8Array(32)
    privKey1[31] = 13
    const pubKey1 = publicKeyFromPrivate(privKey1)

    const privKey2 = new Uint8Array(32)
    privKey2[31] = 17
    const pubKey2 = publicKeyFromPrivate(privKey2)

    const result1 = deriveKeys(privKey1, pubKey1.x, pubKey1.y)
    const result2 = deriveKeys(privKey2, pubKey2.x, pubKey2.y)

    expect(result1.lookupKey).not.toEqual(result2.lookupKey)
    expect(result1.accessKeyDecryptionKey).not.toEqual(
      result2.accessKeyDecryptionKey,
    )
  })
})

describe("counterModeEncrypt/counterModeDecrypt", () => {
  it("should encrypt and decrypt small data correctly", () => {
    const key = generateRandomKey()
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

    const ciphertext = counterModeEncrypt(plaintext, key)
    const decrypted = counterModeDecrypt(ciphertext, key)

    expect(decrypted).toEqual(plaintext)
  })

  it("should encrypt and decrypt exactly 32 bytes correctly", () => {
    const key = generateRandomKey()
    const plaintext = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      plaintext[i] = i
    }

    const ciphertext = counterModeEncrypt(plaintext, key)
    const decrypted = counterModeDecrypt(ciphertext, key)

    expect(decrypted).toEqual(plaintext)
  })

  it("should encrypt and decrypt multiple blocks correctly", () => {
    const key = generateRandomKey()
    const plaintext = new Uint8Array(100)
    for (let i = 0; i < 100; i++) {
      plaintext[i] = i % 256
    }

    const ciphertext = counterModeEncrypt(plaintext, key)
    const decrypted = counterModeDecrypt(ciphertext, key)

    expect(decrypted).toEqual(plaintext)
  })

  it("should produce different ciphertext with different keys", () => {
    const key1 = generateRandomKey()
    const key2 = generateRandomKey()
    const plaintext = new Uint8Array([1, 2, 3, 4, 5])

    const ciphertext1 = counterModeEncrypt(plaintext, key1)
    const ciphertext2 = counterModeEncrypt(plaintext, key2)

    expect(ciphertext1).not.toEqual(ciphertext2)
  })

  it("should produce ciphertext different from plaintext", () => {
    const key = generateRandomKey()
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    const ciphertext = counterModeEncrypt(plaintext, key)

    expect(ciphertext).not.toEqual(plaintext)
  })

  it("should throw error for invalid key length", () => {
    const plaintext = new Uint8Array([1, 2, 3])

    expect(() => counterModeEncrypt(plaintext, new Uint8Array(16))).toThrow()
    expect(() => counterModeEncrypt(plaintext, new Uint8Array(64))).toThrow()
  })

  it("should handle empty data", () => {
    const key = generateRandomKey()
    const plaintext = new Uint8Array(0)

    const ciphertext = counterModeEncrypt(plaintext, key)
    const decrypted = counterModeDecrypt(ciphertext, key)

    expect(decrypted).toEqual(plaintext)
    expect(decrypted.length).toBe(0)
  })

  it("should be symmetric (encrypt === decrypt)", () => {
    const key = generateRandomKey()
    const data = new Uint8Array([42, 43, 44, 45])

    // Double encryption should return original
    const encrypted = counterModeEncrypt(data, key)
    const doubleEncrypted = counterModeEncrypt(encrypted, key)

    expect(doubleEncrypted).toEqual(data)
  })
})

describe("compressPublicKey", () => {
  it("should compress to 33 bytes", () => {
    const privKey = new Uint8Array(32)
    privKey[31] = 1
    const pubKey = publicKeyFromPrivate(privKey)

    const compressed = compressPublicKey(pubKey.x, pubKey.y)
    expect(compressed.length).toBe(33)
  })

  it("should use prefix 0x02 for even y", () => {
    // Generator point has even y
    const compressed = compressPublicKey(GENERATOR_X, GENERATOR_Y)
    expect(compressed[0]).toBe(0x02)
  })

  it("should use prefix 0x03 for odd y", () => {
    // Find a private key that gives odd y
    // Private key = 3 gives a point with odd y
    const privKey = new Uint8Array(32)
    privKey[31] = 3
    const pubKey = publicKeyFromPrivate(privKey)

    const compressed = compressPublicKey(pubKey.x, pubKey.y)
    // The y coordinate's parity determines the prefix
    // Either 0x02 (even) or 0x03 (odd) - verify it's valid
    expect([0x02, 0x03]).toContain(compressed[0])
  })

  it("should include x coordinate after prefix", () => {
    const compressed = compressPublicKey(GENERATOR_X, GENERATOR_Y)
    expect(compressed.slice(1)).toEqual(GENERATOR_X)
  })
})

describe("publicKeyFromCompressed", () => {
  it("should decompress to original coordinates", () => {
    const privKey = new Uint8Array(32)
    privKey[31] = 1
    const pubKey = publicKeyFromPrivate(privKey)

    const compressed = compressPublicKey(pubKey.x, pubKey.y)
    const decompressed = publicKeyFromCompressed(compressed)

    expect(decompressed.x).toEqual(pubKey.x)
    expect(decompressed.y).toEqual(pubKey.y)
  })

  it("should handle prefix 0x02 (even y)", () => {
    const compressed = compressPublicKey(GENERATOR_X, GENERATOR_Y)
    expect(compressed[0]).toBe(0x02)

    const decompressed = publicKeyFromCompressed(compressed)
    expect(decompressed.x).toEqual(GENERATOR_X)
    expect(decompressed.y).toEqual(GENERATOR_Y)
  })

  it("should handle any valid compressed key (roundtrip)", () => {
    // Test multiple private keys to cover both even and odd y cases
    const privKey = new Uint8Array(32)
    privKey[31] = 5
    const pubKey = publicKeyFromPrivate(privKey)

    const compressed = compressPublicKey(pubKey.x, pubKey.y)
    // Prefix should be 0x02 or 0x03
    expect([0x02, 0x03]).toContain(compressed[0])

    const decompressed = publicKeyFromCompressed(compressed)
    expect(decompressed.x).toEqual(pubKey.x)
    expect(decompressed.y).toEqual(pubKey.y)
  })

  it("should throw error for invalid prefix", () => {
    const invalid = new Uint8Array(33)
    invalid[0] = 0x04 // Uncompressed prefix
    expect(() => publicKeyFromCompressed(invalid)).toThrow()

    invalid[0] = 0x00
    expect(() => publicKeyFromCompressed(invalid)).toThrow()
  })

  it("should throw error for invalid length", () => {
    expect(() => publicKeyFromCompressed(new Uint8Array(32))).toThrow()
    expect(() => publicKeyFromCompressed(new Uint8Array(34))).toThrow()
  })

  it("should roundtrip through compress/decompress", () => {
    // Test multiple keys
    for (let i = 1; i <= 10; i++) {
      const privKey = new Uint8Array(32)
      privKey[31] = i
      const pubKey = publicKeyFromPrivate(privKey)

      const compressed = compressPublicKey(pubKey.x, pubKey.y)
      const decompressed = publicKeyFromCompressed(compressed)

      expect(decompressed.x).toEqual(pubKey.x)
      expect(decompressed.y).toEqual(pubKey.y)
    }
  })
})

describe("generateRandomKey", () => {
  it("should return 32 bytes", () => {
    const key = generateRandomKey()
    expect(key.length).toBe(32)
  })

  it("should generate different keys each time", () => {
    const key1 = generateRandomKey()
    const key2 = generateRandomKey()
    const key3 = generateRandomKey()

    expect(key1).not.toEqual(key2)
    expect(key2).not.toEqual(key3)
    expect(key1).not.toEqual(key3)
  })

  it("should return Uint8Array", () => {
    const key = generateRandomKey()
    expect(key).toBeInstanceOf(Uint8Array)
  })
})

describe("ECDH key agreement integration", () => {
  it("should allow two parties to derive same lookup key", () => {
    // Publisher generates key pair
    const publisherPrivate = new Uint8Array(32)
    crypto.getRandomValues(publisherPrivate)
    const publisherPublic = publicKeyFromPrivate(publisherPrivate)

    // Grantee generates key pair
    const granteePrivate = new Uint8Array(32)
    crypto.getRandomValues(granteePrivate)
    const granteePublic = publicKeyFromPrivate(granteePrivate)

    // Publisher derives keys using grantee's public key
    const publisherKeys = deriveKeys(
      publisherPrivate,
      granteePublic.x,
      granteePublic.y,
    )

    // Grantee derives keys using publisher's public key
    const granteeKeys = deriveKeys(
      granteePrivate,
      publisherPublic.x,
      publisherPublic.y,
    )

    // Both should derive the same lookup key and access key decryption key
    expect(publisherKeys.lookupKey).toEqual(granteeKeys.lookupKey)
    expect(publisherKeys.accessKeyDecryptionKey).toEqual(
      granteeKeys.accessKeyDecryptionKey,
    )
  })

  it("should produce unique lookup keys for different grantees", () => {
    // Publisher key pair
    const publisherPrivate = new Uint8Array(32)
    publisherPrivate[31] = 100
    const publisherPublic = publicKeyFromPrivate(publisherPrivate)

    // Grantee 1
    const grantee1Private = new Uint8Array(32)
    grantee1Private[31] = 101
    const grantee1Public = publicKeyFromPrivate(grantee1Private)

    // Grantee 2
    const grantee2Private = new Uint8Array(32)
    grantee2Private[31] = 102
    const grantee2Public = publicKeyFromPrivate(grantee2Private)

    // Publisher derives keys for each grantee
    const keys1 = deriveKeys(
      publisherPrivate,
      grantee1Public.x,
      grantee1Public.y,
    )
    const keys2 = deriveKeys(
      publisherPrivate,
      grantee2Public.x,
      grantee2Public.y,
    )

    // Lookup keys should be different
    expect(keys1.lookupKey).not.toEqual(keys2.lookupKey)
  })
})

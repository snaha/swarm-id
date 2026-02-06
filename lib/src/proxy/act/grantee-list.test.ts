/**
 * Unit tests for Grantee List Management
 */

import { describe, it, expect } from "vitest"
import {
  serializeGranteeList,
  deserializeGranteeList,
  encryptGranteeList,
  decryptGranteeList,
  serializeAndEncryptGranteeList,
  decryptAndDeserializeGranteeList,
  addToGranteeList,
  removeFromGranteeList,
  deriveGranteeListEncryptionKey,
  type UncompressedPublicKey,
} from "./grantee-list"
import { publicKeyFromPrivate } from "./crypto"

// Constants
const UNCOMPRESSED_PUBLIC_KEY_SIZE = 65
const UNCOMPRESSED_PREFIX = 0x04
const PUBLIC_KEY_COORD_SIZE = 32

// Helper to create a random 32-byte array
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

// Helper to create a test public key from seed
function createTestPublicKey(seed: number): UncompressedPublicKey {
  const privKey = new Uint8Array(32)
  privKey[31] = seed
  return publicKeyFromPrivate(privKey)
}

// Helper to create multiple test public keys
function createTestPublicKeys(
  count: number,
  startSeed = 1,
): UncompressedPublicKey[] {
  return Array.from({ length: count }, (_, i) =>
    createTestPublicKey(startSeed + i),
  )
}

describe("Serialization format", () => {
  it("serializeGranteeList should produce 65-byte entries per grantee", () => {
    const grantees = createTestPublicKeys(3)
    const serialized = serializeGranteeList(grantees)

    expect(serialized.length).toBe(3 * UNCOMPRESSED_PUBLIC_KEY_SIZE)
  })

  it("serializeGranteeList should use 0x04 prefix for uncompressed keys", () => {
    const grantees = createTestPublicKeys(2)
    const serialized = serializeGranteeList(grantees)

    // Check prefix for first grantee
    expect(serialized[0]).toBe(UNCOMPRESSED_PREFIX)

    // Check prefix for second grantee
    expect(serialized[UNCOMPRESSED_PUBLIC_KEY_SIZE]).toBe(UNCOMPRESSED_PREFIX)
  })

  it("serializeGranteeList should correctly encode x and y coordinates", () => {
    const grantee: UncompressedPublicKey = {
      x: new Uint8Array(32).fill(0xaa),
      y: new Uint8Array(32).fill(0xbb),
    }
    const serialized = serializeGranteeList([grantee])

    // Check prefix
    expect(serialized[0]).toBe(UNCOMPRESSED_PREFIX)

    // Check x coordinate (bytes 1-32)
    for (let i = 1; i <= PUBLIC_KEY_COORD_SIZE; i++) {
      expect(serialized[i]).toBe(0xaa)
    }

    // Check y coordinate (bytes 33-64)
    for (
      let i = 1 + PUBLIC_KEY_COORD_SIZE;
      i < UNCOMPRESSED_PUBLIC_KEY_SIZE;
      i++
    ) {
      expect(serialized[i]).toBe(0xbb)
    }
  })

  it("serializeGranteeList should handle empty list", () => {
    const serialized = serializeGranteeList([])
    expect(serialized.length).toBe(0)
  })

  it("deserializeGranteeList should parse concatenated keys", () => {
    const grantees = createTestPublicKeys(3)
    const serialized = serializeGranteeList(grantees)
    const deserialized = deserializeGranteeList(serialized)

    expect(deserialized.length).toBe(3)

    for (let i = 0; i < 3; i++) {
      expect(deserialized[i].x).toEqual(grantees[i].x)
      expect(deserialized[i].y).toEqual(grantees[i].y)
    }
  })

  it("deserializeGranteeList should handle empty data", () => {
    const deserialized = deserializeGranteeList(new Uint8Array(0))
    expect(deserialized).toEqual([])
  })

  it("deserializeGranteeList should throw on invalid length", () => {
    // Not a multiple of 65
    const invalidData = new Uint8Array(100)
    expect(() => deserializeGranteeList(invalidData)).toThrow(
      "Invalid grantee list length",
    )
  })

  it("deserializeGranteeList should throw on invalid prefix", () => {
    // Create valid-length data but with wrong prefix
    const invalidData = new Uint8Array(65)
    invalidData[0] = 0x02 // Wrong prefix (should be 0x04)

    expect(() => deserializeGranteeList(invalidData)).toThrow(
      "Invalid public key prefix",
    )
  })
})

describe("Encryption", () => {
  it("deriveGranteeListEncryptionKey should derive consistent key", () => {
    const publisherPrivKey = randomBytes(32)

    const key1 = deriveGranteeListEncryptionKey(publisherPrivKey)
    const key2 = deriveGranteeListEncryptionKey(publisherPrivKey)

    expect(key1).toEqual(key2)
    expect(key1.length).toBe(32)
  })

  it("deriveGranteeListEncryptionKey should produce different keys for different publishers", () => {
    const privKey1 = randomBytes(32)
    const privKey2 = randomBytes(32)

    const key1 = deriveGranteeListEncryptionKey(privKey1)
    const key2 = deriveGranteeListEncryptionKey(privKey2)

    expect(key1).not.toEqual(key2)
  })

  it("encryptGranteeList/decryptGranteeList should roundtrip", () => {
    const publisherPrivKey = randomBytes(32)
    const grantees = createTestPublicKeys(3)
    const serialized = serializeGranteeList(grantees)

    const encrypted = encryptGranteeList(serialized, publisherPrivKey)
    const decrypted = decryptGranteeList(encrypted, publisherPrivKey)

    expect(decrypted).toEqual(serialized)
  })

  it("encryptGranteeList should produce different output than input", () => {
    const publisherPrivKey = randomBytes(32)
    const grantees = createTestPublicKeys(2)
    const serialized = serializeGranteeList(grantees)

    const encrypted = encryptGranteeList(serialized, publisherPrivKey)

    // Encrypted data should differ from original
    expect(encrypted).not.toEqual(serialized)
    // But same length
    expect(encrypted.length).toBe(serialized.length)
  })

  it("serializeAndEncryptGranteeList should combine operations", () => {
    const publisherPrivKey = randomBytes(32)
    const grantees = createTestPublicKeys(3)

    const combined = serializeAndEncryptGranteeList(grantees, publisherPrivKey)

    // Manual approach
    const serialized = serializeGranteeList(grantees)
    const encrypted = encryptGranteeList(serialized, publisherPrivKey)

    expect(combined).toEqual(encrypted)
  })

  it("decryptAndDeserializeGranteeList should combine operations", () => {
    const publisherPrivKey = randomBytes(32)
    const grantees = createTestPublicKeys(3)

    const encrypted = serializeAndEncryptGranteeList(grantees, publisherPrivKey)
    const decrypted = decryptAndDeserializeGranteeList(
      encrypted,
      publisherPrivKey,
    )

    expect(decrypted.length).toBe(3)
    for (let i = 0; i < 3; i++) {
      expect(decrypted[i].x).toEqual(grantees[i].x)
      expect(decrypted[i].y).toEqual(grantees[i].y)
    }
  })
})

describe("List operations", () => {
  it("addToGranteeList should add new grantees to existing list", () => {
    const publisherPrivKey = randomBytes(32)
    const existingGrantees = createTestPublicKeys(2, 1)
    const newGrantees = createTestPublicKeys(2, 100)

    const existingEncrypted = serializeAndEncryptGranteeList(
      existingGrantees,
      publisherPrivKey,
    )

    const updatedEncrypted = addToGranteeList(
      existingEncrypted,
      newGrantees,
      publisherPrivKey,
    )

    const result = decryptAndDeserializeGranteeList(
      updatedEncrypted,
      publisherPrivKey,
    )

    expect(result.length).toBe(4)

    // Check existing grantees are present
    for (const grantee of existingGrantees) {
      expect(result.some((g) => g.x.every((v, i) => v === grantee.x[i]))).toBe(
        true,
      )
    }

    // Check new grantees are present
    for (const grantee of newGrantees) {
      expect(result.some((g) => g.x.every((v, i) => v === grantee.x[i]))).toBe(
        true,
      )
    }
  })

  it("addToGranteeList should handle empty existing list", () => {
    const publisherPrivKey = randomBytes(32)
    const newGrantees = createTestPublicKeys(2)

    const emptyEncrypted = serializeAndEncryptGranteeList([], publisherPrivKey)

    const updatedEncrypted = addToGranteeList(
      emptyEncrypted,
      newGrantees,
      publisherPrivKey,
    )

    const result = decryptAndDeserializeGranteeList(
      updatedEncrypted,
      publisherPrivKey,
    )

    expect(result.length).toBe(2)
  })

  it("removeFromGranteeList should remove specified grantees", () => {
    const publisherPrivKey = randomBytes(32)
    const grantees = createTestPublicKeys(4, 1)
    const toRemove = [grantees[1], grantees[3]] // Remove 2nd and 4th

    const encrypted = serializeAndEncryptGranteeList(grantees, publisherPrivKey)

    const updatedEncrypted = removeFromGranteeList(
      encrypted,
      toRemove,
      publisherPrivKey,
    )

    const result = decryptAndDeserializeGranteeList(
      updatedEncrypted,
      publisherPrivKey,
    )

    expect(result.length).toBe(2)

    // Check removed grantees are not present
    for (const removed of toRemove) {
      expect(result.some((g) => g.x.every((v, i) => v === removed.x[i]))).toBe(
        false,
      )
    }

    // Check remaining grantees are present
    expect(
      result.some((g) => g.x.every((v, i) => v === grantees[0].x[i])),
    ).toBe(true)
    expect(
      result.some((g) => g.x.every((v, i) => v === grantees[2].x[i])),
    ).toBe(true)
  })

  it("removeFromGranteeList should handle removing non-existent grantees", () => {
    const publisherPrivKey = randomBytes(32)
    const grantees = createTestPublicKeys(2, 1)
    const nonExistent = createTestPublicKeys(1, 100)

    const encrypted = serializeAndEncryptGranteeList(grantees, publisherPrivKey)

    const updatedEncrypted = removeFromGranteeList(
      encrypted,
      nonExistent,
      publisherPrivKey,
    )

    const result = decryptAndDeserializeGranteeList(
      updatedEncrypted,
      publisherPrivKey,
    )

    // List should be unchanged
    expect(result.length).toBe(2)
  })

  it("removeFromGranteeList should handle removing all grantees", () => {
    const publisherPrivKey = randomBytes(32)
    const grantees = createTestPublicKeys(2, 1)

    const encrypted = serializeAndEncryptGranteeList(grantees, publisherPrivKey)

    const updatedEncrypted = removeFromGranteeList(
      encrypted,
      grantees,
      publisherPrivKey,
    )

    const result = decryptAndDeserializeGranteeList(
      updatedEncrypted,
      publisherPrivKey,
    )

    expect(result.length).toBe(0)
  })
})

describe("Roundtrip tests", () => {
  it("should preserve all data through serialize/encrypt/decrypt/deserialize cycle", () => {
    const publisherPrivKey = randomBytes(32)
    const grantees = createTestPublicKeys(5, 1)

    const encrypted = serializeAndEncryptGranteeList(grantees, publisherPrivKey)
    const result = decryptAndDeserializeGranteeList(encrypted, publisherPrivKey)

    expect(result.length).toBe(5)

    for (let i = 0; i < 5; i++) {
      expect(result[i].x).toEqual(grantees[i].x)
      expect(result[i].y).toEqual(grantees[i].y)
    }
  })

  it("should handle large number of grantees", () => {
    const publisherPrivKey = randomBytes(32)
    const grantees = createTestPublicKeys(100, 1)

    const encrypted = serializeAndEncryptGranteeList(grantees, publisherPrivKey)
    const result = decryptAndDeserializeGranteeList(encrypted, publisherPrivKey)

    expect(result.length).toBe(100)
  })

  it("different publishers cannot decrypt each other's grantee lists", () => {
    const publisherPrivKey1 = randomBytes(32)
    const publisherPrivKey2 = randomBytes(32)
    const grantees = createTestPublicKeys(2)

    const encrypted = serializeAndEncryptGranteeList(
      grantees,
      publisherPrivKey1,
    )

    // Attempting to decrypt with wrong key will produce garbage
    // The decrypted data may not be a valid grantee list format
    const wrongDecrypted = decryptGranteeList(encrypted, publisherPrivKey2)

    // The data will be different from original serialized
    const correctSerialized = serializeGranteeList(grantees)
    expect(wrongDecrypted).not.toEqual(correctSerialized)
  })
})

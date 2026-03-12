/**
 * Unit tests for encrypted content-addressed chunk (CAC) creation and decryption
 */

import { describe, it, expect } from "vitest"
import { Reference } from "@ethersphere/bee-js"
import {
  makeEncryptedContentAddressedChunk,
  decryptEncryptedChunk,
  extractEncryptionKey,
  extractChunkAddress,
} from "./encrypted-cac"
import { generateRandomKey } from "./encryption"

// ============================================================================
// makeEncryptedContentAddressedChunk Tests
// ============================================================================

describe("makeEncryptedContentAddressedChunk", () => {
  describe("chunk structure", () => {
    it("should create encrypted chunk with correct structure", () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5])
      const chunk = makeEncryptedContentAddressedChunk(payload)

      // data should be encrypted span (8 bytes) + encrypted data (4096 bytes)
      expect(chunk.data.length).toBe(4104)
    })

    it("should produce encrypted data of 4104 bytes (8 span + 4096 data)", () => {
      const payload = new Uint8Array([10, 20, 30])
      const chunk = makeEncryptedContentAddressedChunk(payload)

      expect(chunk.data.length).toBe(4104)
    })

    it("should produce reference of 64 bytes (address + key)", () => {
      const payload = new Uint8Array([1, 2, 3, 4])
      const chunk = makeEncryptedContentAddressedChunk(payload)

      expect(chunk.reference.toUint8Array().length).toBe(64)
    })

    it("should include 32-byte encryption key", () => {
      const payload = new Uint8Array([5, 6, 7, 8])
      const chunk = makeEncryptedContentAddressedChunk(payload)

      expect(chunk.encryptionKey.length).toBe(32)
    })

    it("should include 32-byte address", () => {
      const payload = new Uint8Array([9, 10, 11, 12])
      const chunk = makeEncryptedContentAddressedChunk(payload)

      expect(chunk.address.toUint8Array().length).toBe(32)
    })
  })

  describe("encryption key handling", () => {
    it("should use custom encryption key when provided", () => {
      const payload = new Uint8Array([1, 2, 3, 4])
      const customKey = generateRandomKey()
      const chunk = makeEncryptedContentAddressedChunk(payload, customKey)

      expect(chunk.encryptionKey).toBe(customKey)
    })

    it("should generate random key when not provided", () => {
      const payload = new Uint8Array([1, 2, 3, 4])

      const chunk1 = makeEncryptedContentAddressedChunk(payload)
      const chunk2 = makeEncryptedContentAddressedChunk(payload)

      expect(chunk1.encryptionKey).not.toEqual(chunk2.encryptionKey)
    })

    it("should produce same encrypted data with same key", () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5])
      const key = generateRandomKey()

      const chunk1 = makeEncryptedContentAddressedChunk(payload, key)
      const chunk2 = makeEncryptedContentAddressedChunk(payload, key)

      expect(chunk1.data).toEqual(chunk2.data)
      expect(chunk1.address.toUint8Array()).toEqual(
        chunk2.address.toUint8Array(),
      )
    })

    it("should produce different encrypted data with different keys", () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5])
      const key1 = generateRandomKey()
      const key2 = generateRandomKey()

      const chunk1 = makeEncryptedContentAddressedChunk(payload, key1)
      const chunk2 = makeEncryptedContentAddressedChunk(payload, key2)

      expect(chunk1.data).not.toEqual(chunk2.data)
    })
  })

  describe("string input handling", () => {
    it("should accept string input and encode as UTF-8", () => {
      const text = "Hello, Encrypted World!"
      const chunk = makeEncryptedContentAddressedChunk(text)

      expect(chunk.data.length).toBe(4104)
      expect(chunk.reference.toUint8Array().length).toBe(64)
    })

    it("should handle Unicode strings", () => {
      const text = "Encrypted 世界! 🔐"
      const chunk = makeEncryptedContentAddressedChunk(text)

      expect(chunk.data.length).toBe(4104)
    })
  })

  describe("error handling", () => {
    it("should throw error on empty payload", () => {
      const emptyPayload = new Uint8Array(0)

      expect(() => makeEncryptedContentAddressedChunk(emptyPayload)).toThrow(
        /payload size .* exceeds limits/,
      )
    })

    it("should throw error on empty string", () => {
      expect(() => makeEncryptedContentAddressedChunk("")).toThrow(
        /payload size .* exceeds limits/,
      )
    })

    it("should throw error on payload larger than 4096 bytes", () => {
      const largePayload = new Uint8Array(4097)

      expect(() => makeEncryptedContentAddressedChunk(largePayload)).toThrow(
        /payload size .* exceeds limits/,
      )
    })
  })

  describe("payload size variations", () => {
    it("should handle minimum payload size (1 byte)", () => {
      const payload = new Uint8Array([42])
      const chunk = makeEncryptedContentAddressedChunk(payload)

      expect(chunk.span.toBigInt()).toBe(BigInt(1))
      expect(chunk.data.length).toBe(4104)
    })

    it("should handle maximum payload size (4096 bytes)", () => {
      const payload = new Uint8Array(4096)
      for (let i = 0; i < 4096; i++) {
        payload[i] = i % 256
      }
      const chunk = makeEncryptedContentAddressedChunk(payload)

      expect(chunk.span.toBigInt()).toBe(BigInt(4096))
      expect(chunk.data.length).toBe(4104)
    })
  })
})

// ============================================================================
// decryptEncryptedChunk Tests
// ============================================================================

describe("decryptEncryptedChunk", () => {
  describe("round-trip encryption/decryption", () => {
    it("should recover original data after encrypt then decrypt", () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      const chunk = makeEncryptedContentAddressedChunk(payload)

      const decrypted = decryptEncryptedChunk(chunk.data, chunk.encryptionKey)

      // First 8 bytes are span, rest is payload (padded to 4096)
      const decryptedPayload = decrypted.slice(8, 8 + payload.length)
      expect(decryptedPayload).toEqual(payload)
    })

    it("should preserve original span value after decryption", () => {
      const payload = new Uint8Array([10, 20, 30, 40, 50])
      const chunk = makeEncryptedContentAddressedChunk(payload)

      const decrypted = decryptEncryptedChunk(chunk.data, chunk.encryptionKey)

      // Extract span from decrypted data (first 8 bytes, little-endian)
      const decryptedSpanView = new DataView(decrypted.buffer, 0, 8)
      const decryptedSpan = decryptedSpanView.getBigUint64(0, true)

      expect(decryptedSpan).toBe(BigInt(payload.length))
    })

    it("should round-trip string content", () => {
      const text = "Hello, World! This is encrypted."
      const encoder = new TextEncoder()
      const expectedPayload = encoder.encode(text)

      const chunk = makeEncryptedContentAddressedChunk(text)
      const decrypted = decryptEncryptedChunk(chunk.data, chunk.encryptionKey)

      const decryptedPayload = decrypted.slice(8, 8 + expectedPayload.length)
      expect(decryptedPayload).toEqual(expectedPayload)
    })

    it("should round-trip maximum size payload", () => {
      const payload = new Uint8Array(4096)
      for (let i = 0; i < 4096; i++) {
        payload[i] = i % 256
      }

      const chunk = makeEncryptedContentAddressedChunk(payload)
      const decrypted = decryptEncryptedChunk(chunk.data, chunk.encryptionKey)

      // For max size, decrypted should match exactly (no extra padding)
      const decryptedPayload = decrypted.slice(8)
      expect(decryptedPayload).toEqual(payload)
    })

    it("should round-trip various payload sizes", () => {
      const sizes = [1, 10, 32, 64, 100, 256, 512, 1024, 2048, 4096]

      for (const size of sizes) {
        const payload = new Uint8Array(size)
        for (let i = 0; i < size; i++) {
          payload[i] = i % 256
        }

        const chunk = makeEncryptedContentAddressedChunk(payload)
        const decrypted = decryptEncryptedChunk(chunk.data, chunk.encryptionKey)

        const decryptedPayload = decrypted.slice(8, 8 + size)
        expect(decryptedPayload).toEqual(payload)
      }
    })
  })

  describe("key sensitivity", () => {
    it("should fail to decrypt with wrong key", () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5])
      const chunk = makeEncryptedContentAddressedChunk(payload)
      const wrongKey = generateRandomKey()

      const decrypted = decryptEncryptedChunk(chunk.data, wrongKey)

      // Decryption doesn't throw but produces wrong data
      const decryptedPayload = decrypted.slice(8, 8 + payload.length)
      expect(decryptedPayload).not.toEqual(payload)
    })
  })
})

// ============================================================================
// extractEncryptionKey Tests
// ============================================================================

describe("extractEncryptionKey", () => {
  it("should return correct 32-byte key from 64-byte reference", () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    const customKey = generateRandomKey()
    const chunk = makeEncryptedContentAddressedChunk(payload, customKey)

    const extractedKey = extractEncryptionKey(chunk.reference)

    expect(extractedKey).toEqual(customKey)
    expect(extractedKey.length).toBe(32)
  })

  it("should extract key that can decrypt the chunk", () => {
    const payload = new Uint8Array([5, 10, 15, 20])
    const chunk = makeEncryptedContentAddressedChunk(payload)

    const extractedKey = extractEncryptionKey(chunk.reference)
    const decrypted = decryptEncryptedChunk(chunk.data, extractedKey)

    const decryptedPayload = decrypted.slice(8, 8 + payload.length)
    expect(decryptedPayload).toEqual(payload)
  })

  it("should throw error on non-64-byte reference", () => {
    // 32-byte reference (non-encrypted)
    const shortRef = new Reference(new Uint8Array(32))
    expect(() => extractEncryptionKey(shortRef)).toThrow(
      /Invalid encrypted reference length/,
    )

    // Note: Reference constructor validates that bytes are 32 or 64, so we can't test
    // with lengths like 128. The 32-byte case is sufficient to test our validation.
  })
})

// ============================================================================
// extractChunkAddress Tests
// ============================================================================

describe("extractChunkAddress", () => {
  it("should return correct 32-byte address from 64-byte reference", () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    const chunk = makeEncryptedContentAddressedChunk(payload)

    const extractedAddress = extractChunkAddress(chunk.reference)

    expect(extractedAddress.toUint8Array()).toEqual(
      chunk.address.toUint8Array(),
    )
    expect(extractedAddress.toUint8Array().length).toBe(32)
  })

  it("should extract address that matches chunk address", () => {
    const payload = new Uint8Array([100, 200, 50, 25])
    const key = generateRandomKey()
    const chunk = makeEncryptedContentAddressedChunk(payload, key)

    const extractedAddress = extractChunkAddress(chunk.reference)

    expect(extractedAddress.toUint8Array()).toEqual(
      chunk.address.toUint8Array(),
    )
  })

  it("should throw error on non-64-byte reference", () => {
    // 32-byte reference (non-encrypted)
    const shortRef = new Reference(new Uint8Array(32))
    expect(() => extractChunkAddress(shortRef)).toThrow(
      /Invalid encrypted reference length/,
    )

    // Note: Reference constructor validates that bytes are 32 or 64, so we can't test
    // with lengths like 128. The 32-byte case is sufficient to test our validation.
  })

  it("should extract address that differs from encryption key", () => {
    const payload = new Uint8Array([1, 2, 3])
    const chunk = makeEncryptedContentAddressedChunk(payload)

    const address = extractChunkAddress(chunk.reference)
    const key = extractEncryptionKey(chunk.reference)

    expect(address.toUint8Array()).not.toEqual(key)
  })
})

// ============================================================================
// Integration Tests
// ============================================================================

describe("encrypted-cac integration", () => {
  it("should support complete workflow: create → extract → decrypt", () => {
    const originalPayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    // Create encrypted chunk
    const chunk = makeEncryptedContentAddressedChunk(originalPayload)

    // Extract address and key from reference
    const address = extractChunkAddress(chunk.reference)
    const key = extractEncryptionKey(chunk.reference)

    // Verify address matches
    expect(address.toUint8Array()).toEqual(chunk.address.toUint8Array())

    // Decrypt using extracted key
    const decrypted = decryptEncryptedChunk(chunk.data, key)
    const decryptedPayload = decrypted.slice(8, 8 + originalPayload.length)

    expect(decryptedPayload).toEqual(originalPayload)
  })

  it("should allow reference to be serialized and deserialized", () => {
    const payload = new Uint8Array([42, 43, 44, 45])
    const chunk = makeEncryptedContentAddressedChunk(payload)

    // Serialize reference to hex
    const referenceHex = chunk.reference.toHex()

    // Deserialize reference
    const deserializedRef = new Reference(referenceHex)

    // Extract and decrypt
    const key = extractEncryptionKey(deserializedRef)
    const decrypted = decryptEncryptedChunk(chunk.data, key)
    const decryptedPayload = decrypted.slice(8, 8 + payload.length)

    expect(decryptedPayload).toEqual(payload)
  })
})

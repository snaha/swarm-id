/**
 * Unit tests for chunk encryption primitives
 */

import { describe, it, expect } from "vitest"
import {
  Encryption,
  generateRandomKey,
  newSpanEncryption,
  newDataEncryption,
  newChunkEncrypter,
  decryptChunkData,
  KEY_LENGTH,
} from "./encryption"

// ============================================================================
// Encryption Class Tests
// ============================================================================

describe("Encryption class", () => {
  describe("round-trip encrypt/decrypt", () => {
    it("should round-trip encrypt/decrypt for various data sizes", () => {
      const key = generateRandomKey()
      const padding = 64

      // Test multiple sizes smaller than padding
      const sizes = [1, 8, 16, 31, 32, 33, 48, 63, 64]
      for (const size of sizes) {
        const data = new Uint8Array(size)
        for (let i = 0; i < size; i++) {
          data[i] = i % 256
        }

        const encrypter = new Encryption(key, padding, 0)
        const encrypted = encrypter.encrypt(data)

        encrypter.reset()
        const decrypted = encrypter.decrypt(encrypted)

        // Decrypted data has padding, so compare only original length
        expect(decrypted.slice(0, size)).toEqual(data)
      }
    })

    it("should pad data smaller than padding size", () => {
      const key = generateRandomKey()
      const padding = 64
      const data = new Uint8Array([1, 2, 3, 4, 5])

      const encrypter = new Encryption(key, padding, 0)
      const encrypted = encrypter.encrypt(data)

      expect(encrypted.length).toBe(padding)
    })

    it("should throw error on data larger than padding", () => {
      const key = generateRandomKey()
      const padding = 32
      const data = new Uint8Array(64)

      const encrypter = new Encryption(key, padding, 0)

      expect(() => encrypter.encrypt(data)).toThrow(
        /data length .* longer than padding/,
      )
    })

    it("should be deterministic (same key + data = same ciphertext)", () => {
      const key = generateRandomKey()
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

      const encrypter1 = new Encryption(key, 32, 0)
      const encrypter2 = new Encryption(key, 32, 0)

      const encrypted1 = encrypter1.encrypt(data)
      const encrypted2 = encrypter2.encrypt(data)

      expect(encrypted1).toEqual(encrypted2)
    })

    it("should produce different ciphertext with different keys", () => {
      const key1 = generateRandomKey()
      const key2 = generateRandomKey()
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

      const encrypter1 = new Encryption(key1, 32, 0)
      const encrypter2 = new Encryption(key2, 32, 0)

      const encrypted1 = encrypter1.encrypt(data)
      const encrypted2 = encrypter2.encrypt(data)

      expect(encrypted1).not.toEqual(encrypted2)
    })

    it("should reset counter correctly", () => {
      const key = generateRandomKey()
      const data = new Uint8Array([1, 2, 3, 4])
      const padding = 32

      const encrypter = new Encryption(key, padding, 0)

      // First encryption
      const encrypted1 = encrypter.encrypt(data)

      // Reset and encrypt again
      encrypter.reset()
      const encrypted2 = encrypter.encrypt(data)

      // Should produce same result after reset
      expect(encrypted1).toEqual(encrypted2)
    })

    it("should encrypt without padding when padding is 0", () => {
      const key = generateRandomKey()
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

      const encrypter = new Encryption(key, 0, 0)
      const encrypted = encrypter.encrypt(data)

      // Without padding, output length equals input length
      expect(encrypted.length).toBe(data.length)
    })
  })

  describe("key() method", () => {
    it("should return the encryption key", () => {
      const key = generateRandomKey()
      const encrypter = new Encryption(key, 0, 0)

      expect(encrypter.key()).toBe(key)
    })
  })

  describe("decrypt validation", () => {
    it("should throw error when decrypt data length differs from padding", () => {
      const key = generateRandomKey()
      const padding = 64
      const wrongSizeData = new Uint8Array(32)

      const decrypter = new Encryption(key, padding, 0)

      expect(() => decrypter.decrypt(wrongSizeData)).toThrow(
        /data length .* different than padding/,
      )
    })
  })
})

// ============================================================================
// generateRandomKey Tests
// ============================================================================

describe("generateRandomKey", () => {
  it("should return correct default length (32 bytes)", () => {
    const key = generateRandomKey()
    expect(key.length).toBe(KEY_LENGTH)
  })

  it("should support custom length", () => {
    const key16 = generateRandomKey(16)
    const key64 = generateRandomKey(64)

    expect(key16.length).toBe(16)
    expect(key64.length).toBe(64)
  })

  it("should generate different keys on each call", () => {
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

// ============================================================================
// newSpanEncryption / newDataEncryption Tests
// ============================================================================

describe("newSpanEncryption", () => {
  it("should return valid encrypter", () => {
    const key = generateRandomKey()
    const encrypter = newSpanEncryption(key)

    expect(encrypter.key()).toBe(key)
    expect(typeof encrypter.encrypt).toBe("function")
    expect(typeof encrypter.decrypt).toBe("function")
    expect(typeof encrypter.reset).toBe("function")
  })

  it("should encrypt span data (8 bytes)", () => {
    const key = generateRandomKey()
    const span = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]) // length 1 in little-endian

    const encrypter = newSpanEncryption(key)
    const encrypted = encrypter.encrypt(span)

    // Span encryption has no padding (padding = 0)
    expect(encrypted.length).toBe(8)
    expect(encrypted).not.toEqual(span)
  })
})

describe("newDataEncryption", () => {
  it("should return valid encrypter", () => {
    const key = generateRandomKey()
    const encrypter = newDataEncryption(key)

    expect(encrypter.key()).toBe(key)
    expect(typeof encrypter.encrypt).toBe("function")
    expect(typeof encrypter.decrypt).toBe("function")
    expect(typeof encrypter.reset).toBe("function")
  })

  it("should pad data to 4096 bytes", () => {
    const key = generateRandomKey()
    const data = new Uint8Array([1, 2, 3, 4, 5])

    const encrypter = newDataEncryption(key)
    const encrypted = encrypter.encrypt(data)

    expect(encrypted.length).toBe(4096)
  })
})

// ============================================================================
// newChunkEncrypter + decryptChunkData Tests
// ============================================================================

describe("newChunkEncrypter + decryptChunkData", () => {
  it("should round-trip chunk encryption/decryption", () => {
    const chunkEncrypter = newChunkEncrypter()

    // Create chunk data: 8-byte span + payload
    const span = new Uint8Array([5, 0, 0, 0, 0, 0, 0, 0])
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const chunkData = new Uint8Array(8 + payload.length)
    chunkData.set(span)
    chunkData.set(payload, 8)

    const { key, encryptedSpan, encryptedData } =
      chunkEncrypter.encryptChunk(chunkData)

    // Verify encrypted parts
    expect(encryptedSpan.length).toBe(8)
    expect(encryptedData.length).toBe(4096)

    // Decrypt
    const encryptedChunkData = new Uint8Array(8 + 4096)
    encryptedChunkData.set(encryptedSpan)
    encryptedChunkData.set(encryptedData, 8)

    const decrypted = decryptChunkData(key, encryptedChunkData)

    // Verify decryption recovers original data (span + payload portion)
    expect(decrypted.slice(0, 8)).toEqual(span)
    expect(decrypted.slice(8, 8 + payload.length)).toEqual(payload)
  })

  it("should produce encrypted span of 8 bytes", () => {
    const chunkEncrypter = newChunkEncrypter()
    const chunkData = new Uint8Array(8 + 100) // span + 100 bytes payload

    const { encryptedSpan } = chunkEncrypter.encryptChunk(chunkData)

    expect(encryptedSpan.length).toBe(8)
  })

  it("should produce encrypted data padded to 4096 bytes", () => {
    const chunkEncrypter = newChunkEncrypter()
    const chunkData = new Uint8Array(8 + 100) // span + 100 bytes payload

    const { encryptedData } = chunkEncrypter.encryptChunk(chunkData)

    expect(encryptedData.length).toBe(4096)
  })

  it("should produce total encrypted chunk of 4104 bytes (8 + 4096)", () => {
    const chunkEncrypter = newChunkEncrypter()
    const chunkData = new Uint8Array(8 + 100)

    const { encryptedSpan, encryptedData } =
      chunkEncrypter.encryptChunk(chunkData)

    const totalLength = encryptedSpan.length + encryptedData.length
    expect(totalLength).toBe(4104)
  })

  it("should use provided encryption key", () => {
    const chunkEncrypter = newChunkEncrypter()
    const customKey = generateRandomKey()
    const chunkData = new Uint8Array(8 + 50)

    const { key } = chunkEncrypter.encryptChunk(chunkData, customKey)

    expect(key).toBe(customKey)
  })

  it("should generate random key when not provided", () => {
    const chunkEncrypter = newChunkEncrypter()
    const chunkData = new Uint8Array(8 + 50)

    const result1 = chunkEncrypter.encryptChunk(chunkData)
    const result2 = chunkEncrypter.encryptChunk(chunkData)

    expect(result1.key).not.toEqual(result2.key)
  })

  it("should produce different encrypted output with different keys", () => {
    const chunkEncrypter = newChunkEncrypter()
    const chunkData = new Uint8Array(8 + 50)
    chunkData.fill(42)

    const key1 = generateRandomKey()
    const key2 = generateRandomKey()

    const result1 = chunkEncrypter.encryptChunk(chunkData, key1)
    const result2 = chunkEncrypter.encryptChunk(chunkData, key2)

    expect(result1.encryptedSpan).not.toEqual(result2.encryptedSpan)
    expect(result1.encryptedData).not.toEqual(result2.encryptedData)
  })

  it("should handle maximum payload size (4096 bytes data)", () => {
    const chunkEncrypter = newChunkEncrypter()
    const chunkData = new Uint8Array(8 + 4096) // span + max payload
    for (let i = 0; i < chunkData.length; i++) {
      chunkData[i] = i % 256
    }

    const { key, encryptedSpan, encryptedData } =
      chunkEncrypter.encryptChunk(chunkData)

    expect(encryptedSpan.length).toBe(8)
    expect(encryptedData.length).toBe(4096)

    // Verify round-trip
    const encryptedChunkData = new Uint8Array(8 + 4096)
    encryptedChunkData.set(encryptedSpan)
    encryptedChunkData.set(encryptedData, 8)

    const decrypted = decryptChunkData(key, encryptedChunkData)
    expect(decrypted).toEqual(chunkData)
  })
})

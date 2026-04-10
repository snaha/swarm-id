// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for encrypted SOC round-trip.
 *
 * These tests verify that:
 * 1. Encrypted SOC upload stores the correct data format
 * 2. Download retrieves and decrypts to match original data
 * 3. The encryption key returned from upload works for decryption
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Identifier, PrivateKey, EthAddress } from "@ethersphere/bee-js"
import type { Bee } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { uploadSOC, type UploadTarget } from "./upload"
import { downloadEncryptedSOC, downloadSOC } from "./download-data"
import {
  MockChunkStore,
  createTestSigner,
  mockFetch,
} from "./feeds/epochs/test-utils"

/**
 * Minimal Bee interface for download operations
 */
type MinimalBee = Pick<Bee, "downloadChunk">

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create test identifier from a string.
 */
function createTestIdentifier(name: string): Identifier {
  const encoder = new TextEncoder()
  const hash = Binary.keccak256(encoder.encode(name))
  return new Identifier(hash)
}

/**
 * Create a subsidised gateway target for testing.
 */
function createSubsidisedTarget(
  gatewayUrl: string = "http://localhost:1633",
): UploadTarget {
  return {
    mode: "subsidised",
    gatewayUrl,
  }
}

/**
 * Mock Bee for download that uses MockChunkStore
 */
function createMockBee(store: MockChunkStore): MinimalBee {
  return {
    async downloadChunk(reference: string): Promise<Uint8Array> {
      return store.get(reference)
    },
  } as MinimalBee
}

// ============================================================================
// Integration Tests
// ============================================================================

describe("Encrypted SOC round-trip integration", () => {
  let originalFetch: typeof global.fetch
  let store: MockChunkStore
  let signer: PrivateKey
  let owner: EthAddress
  let target: UploadTarget

  beforeEach(() => {
    originalFetch = global.fetch
    store = new MockChunkStore()
    signer = createTestSigner()
    owner = signer.publicKey().address()
    target = createSubsidisedTarget()

    // Install mock fetch that stores SOCs in our MockChunkStore
    mockFetch(store, owner)
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  describe("full round-trip tests", () => {
    it("should decrypt downloaded SOC to match original upload (short data)", async () => {
      const originalData = new TextEncoder().encode("Hello SOC!")
      const identifier = createTestIdentifier("round-trip-short")

      // Upload encrypted SOC
      const uploadResult = await uploadSOC(
        target,
        signer,
        identifier,
        originalData,
        {
          encryptionKey: true,
        },
      )

      expect(uploadResult.encryptionKey).toBeDefined()
      expect(uploadResult.encryptionKey!.length).toBe(32)

      // Create mock bee for download
      const mockBee = createMockBee(store)

      // Download and decrypt using the returned encryption key
      const soc = await downloadEncryptedSOC(
        mockBee,
        owner,
        identifier,
        uploadResult.encryptionKey!,
      )

      // Verify payload matches original
      const downloadedText = new TextDecoder().decode(soc.payload)
      expect(downloadedText).toBe("Hello SOC!")
      expect(soc.payload).toEqual(originalData)
    })

    it("should decrypt downloaded SOC to match original upload (binary data)", async () => {
      const originalData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      const identifier = createTestIdentifier("round-trip-binary")

      // Upload encrypted SOC
      const uploadResult = await uploadSOC(
        target,
        signer,
        identifier,
        originalData,
        {
          encryptionKey: true,
        },
      )

      expect(uploadResult.encryptionKey).toBeDefined()

      // Create mock bee for download
      const mockBee = createMockBee(store)

      // Download and decrypt
      const soc = await downloadEncryptedSOC(
        mockBee,
        owner,
        identifier,
        uploadResult.encryptionKey!,
      )

      // Verify payload matches original
      expect(soc.payload).toEqual(originalData)
    })

    it("should decrypt downloaded SOC with custom encryption key", async () => {
      const originalData = new TextEncoder().encode("Custom key test")
      const identifier = createTestIdentifier("round-trip-custom-key")
      const customKey = new Uint8Array(32)
      customKey.fill(42)

      // Upload with custom key
      const uploadResult = await uploadSOC(
        target,
        signer,
        identifier,
        originalData,
        {
          encryptionKey: customKey,
        },
      )

      expect(uploadResult.encryptionKey).toEqual(customKey)

      // Create mock bee for download
      const mockBee = createMockBee(store)

      // Download and decrypt with the same custom key
      const soc = await downloadEncryptedSOC(
        mockBee,
        owner,
        identifier,
        customKey,
      )

      // Verify payload matches original
      const downloadedText = new TextDecoder().decode(soc.payload)
      expect(downloadedText).toBe("Custom key test")
    })

    it("should handle maximum payload size (4096 bytes)", async () => {
      const originalData = new Uint8Array(4096)
      for (let i = 0; i < 4096; i++) {
        originalData[i] = i % 256
      }
      const identifier = createTestIdentifier("round-trip-max-size")

      // Upload encrypted SOC
      const uploadResult = await uploadSOC(
        target,
        signer,
        identifier,
        originalData,
        {
          encryptionKey: true,
        },
      )

      expect(uploadResult.encryptionKey).toBeDefined()

      // Create mock bee for download
      const mockBee = createMockBee(store)

      // Download and decrypt
      const soc = await downloadEncryptedSOC(
        mockBee,
        owner,
        identifier,
        uploadResult.encryptionKey!,
      )

      // Verify payload matches original
      expect(soc.payload).toEqual(originalData)
      expect(soc.span).toBe(4096)
    })

    it("should handle minimum payload size (1 byte)", async () => {
      const originalData = new Uint8Array([42])
      const identifier = createTestIdentifier("round-trip-min-size")

      // Upload encrypted SOC
      const uploadResult = await uploadSOC(
        target,
        signer,
        identifier,
        originalData,
        {
          encryptionKey: true,
        },
      )

      expect(uploadResult.encryptionKey).toBeDefined()

      // Create mock bee for download
      const mockBee = createMockBee(store)

      // Download and decrypt
      const soc = await downloadEncryptedSOC(
        mockBee,
        owner,
        identifier,
        uploadResult.encryptionKey!,
      )

      // Verify payload matches original
      expect(soc.payload).toEqual(originalData)
      expect(soc.span).toBe(1)
    })
  })

  describe("plain SOC round-trip (baseline)", () => {
    it("should download plain SOC to match original upload", async () => {
      const originalData = new TextEncoder().encode("Plain SOC test")
      const identifier = createTestIdentifier("round-trip-plain")

      // Upload plain SOC (no encryption)
      await uploadSOC(target, signer, identifier, originalData)

      // Create mock bee for download
      const mockBee = createMockBee(store)

      // Download plain SOC
      const soc = await downloadSOC(mockBee, owner, identifier)

      // Verify payload matches original
      const downloadedText = new TextDecoder().decode(soc.payload)
      expect(downloadedText).toBe("Plain SOC test")
      expect(soc.payload).toEqual(originalData)
    })
  })

  describe("hex serialization round-trip", () => {
    it("should preserve encryption key through hex conversion", async () => {
      const originalData = new TextEncoder().encode("Hex test")
      const identifier = createTestIdentifier("hex-round-trip")

      // Upload encrypted SOC
      const uploadResult = await uploadSOC(
        target,
        signer,
        identifier,
        originalData,
        {
          encryptionKey: true,
        },
      )

      const key = uploadResult.encryptionKey!

      // Convert to hex and back (simulating what might happen in message passing)
      const hexKey = Binary.uint8ArrayToHex(key)
      const recoveredKey = Binary.hexToUint8Array(hexKey)

      // Verify key survives hex round-trip
      expect(recoveredKey).toEqual(key)
      expect(recoveredKey.length).toBe(32)

      // Create mock bee for download
      const mockBee = createMockBee(store)

      // Download and decrypt with recovered key
      const soc = await downloadEncryptedSOC(
        mockBee,
        owner,
        identifier,
        recoveredKey,
      )

      // Verify payload matches original
      const downloadedText = new TextDecoder().decode(soc.payload)
      expect(downloadedText).toBe("Hex test")
    })

    it("should preserve encryption key through string hex conversion", async () => {
      const originalData = new TextEncoder().encode("String hex test")
      const identifier = createTestIdentifier("string-hex-round-trip")

      // Upload encrypted SOC
      const uploadResult = await uploadSOC(
        target,
        signer,
        identifier,
        originalData,
        {
          encryptionKey: true,
        },
      )

      const key = uploadResult.encryptionKey!
      const hexKey = Binary.uint8ArrayToHex(key)

      // Create mock bee for download
      const mockBee = createMockBee(store)

      // Download and decrypt with hex string key (downloadEncryptedSOC accepts string)
      const soc = await downloadEncryptedSOC(
        mockBee,
        owner,
        identifier,
        hexKey, // Pass as hex string
      )

      // Verify payload matches original
      const downloadedText = new TextDecoder().decode(soc.payload)
      expect(downloadedText).toBe("String hex test")
    })
  })

  describe("error cases", () => {
    it("should fail to decrypt with wrong key", async () => {
      const originalData = new TextEncoder().encode("Wrong key test")
      const identifier = createTestIdentifier("wrong-key")

      // Upload encrypted SOC
      await uploadSOC(target, signer, identifier, originalData, {
        encryptionKey: true,
      })

      // Create mock bee for download
      const mockBee = createMockBee(store)

      // Try to decrypt with wrong key
      const wrongKey = new Uint8Array(32)
      wrongKey.fill(99)

      // This should produce garbage or throw
      // Depending on implementation, decryption with wrong key either:
      // 1. Throws an error
      // 2. Returns garbage data with wrong span
      try {
        const soc = await downloadEncryptedSOC(
          mockBee,
          owner,
          identifier,
          wrongKey,
        )
        // If no error, the decrypted data should be garbage
        const downloadedText = new TextDecoder().decode(soc.payload)
        expect(downloadedText).not.toBe("Wrong key test")
      } catch {
        // Expected - wrong key can cause decryption errors
      }
    })
  })
})

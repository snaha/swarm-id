// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for SOC (Single Owner Chunk) uploads.
 *
 * These tests ensure that the signature always matches the data that gets sent.
 * This is critical because the bug that caused all SOC uploads to fail with
 * "401 invalid chunk" was a signature/data mismatch: the signature covered one
 * address, but the body sent to the server had a different address.
 *
 * For SOCs, the Bee node validates by:
 * 1. Receiving: identifier, signature, body (span + payload)
 * 2. Computing: chunkAddress = BMT_hash(body)
 * 3. Computing: toVerify = hash(identifier + chunkAddress)
 * 4. Verifying: signature.verify(toVerify, owner)
 *
 * If signature was computed over different data than body, the node rejects it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Identifier, PrivateKey } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { uploadSOC, type UploadTarget } from "./upload"
import {
  makeContentAddressedChunk,
  makeEncryptedContentAddressedChunk,
  calculateChunkAddress,
  decryptEncryptedChunk,
} from "../chunk"
import { createTestSigner } from "./feeds/epochs/test-utils"

// ============================================================================
// Test Utilities
// ============================================================================

interface CapturedSOCUpload {
  url: string
  body: Uint8Array
  signature: string
  owner: string
  identifier: string
}

/**
 * Create a fetch mock that captures SOC upload details for verification.
 */
function createCapturingFetch(): {
  fetch: typeof global.fetch
  getCaptured: () => CapturedSOCUpload | undefined
} {
  let captured: CapturedSOCUpload | undefined

  const mockFetch = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url.toString()

    if (urlStr.includes("/soc/")) {
      // Extract body
      const bodyInit = init?.body
      let bodyBytes: Uint8Array
      if (bodyInit instanceof Uint8Array) {
        bodyBytes = bodyInit
      } else if (bodyInit instanceof ArrayBuffer) {
        bodyBytes = new Uint8Array(bodyInit)
      } else if (bodyInit instanceof Blob) {
        bodyBytes = new Uint8Array(await bodyInit.arrayBuffer())
      } else {
        throw new Error(`Unexpected body type: ${typeof bodyInit}`)
      }

      // Parse URL: /soc/{owner}/{id}?sig={signature}
      const socPath = urlStr.split("/soc/")[1]
      const parts = socPath.split("/")
      const owner = parts[0]
      const idAndSig = parts[1].split("?sig=")
      const identifier = idAndSig[0]
      const signature = idAndSig[1]

      captured = {
        url: urlStr,
        body: bodyBytes,
        signature,
        owner,
        identifier,
      }

      // Return success response
      return new Response(
        JSON.stringify({ reference: "mock-reference-12345" }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      )
    }

    throw new Error(`Unexpected fetch URL: ${urlStr}`)
  }

  return {
    fetch: mockFetch as typeof global.fetch,
    getCaptured: () => captured,
  }
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
 * Create test identifier from a string.
 */
function createTestIdentifier(name: string): Identifier {
  const encoder = new TextEncoder()
  const hash = Binary.keccak256(encoder.encode(name))
  return new Identifier(hash)
}

// ============================================================================
// Tests
// ============================================================================

describe("SOC upload signature validation", () => {
  let originalFetch: typeof global.fetch
  let capturingFetch: ReturnType<typeof createCapturingFetch>
  let signer: PrivateKey
  let target: UploadTarget

  beforeEach(() => {
    originalFetch = global.fetch
    capturingFetch = createCapturingFetch()
    global.fetch = capturingFetch.fetch
    signer = createTestSigner()
    target = createSubsidisedTarget()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  describe("plain SOC signature consistency", () => {
    it("should sign using unencrypted chunk address for plain SOC", async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      const identifier = createTestIdentifier("test-plain-soc")

      await uploadSOC(target, signer, identifier, data)

      const captured = capturingFetch.getCaptured()
      expect(captured).toBeDefined()

      // Verify: body matches unencrypted CAC data
      const expectedCAC = makeContentAddressedChunk(data)
      expect(captured!.body).toEqual(expectedCAC.data)

      // Verify: signature was computed over hash(identifier + unencrypted_chunk_address)
      const expectedAddress = expectedCAC.address.toUint8Array()
      const toSign = Binary.concatBytes(
        identifier.toUint8Array(),
        expectedAddress,
      )
      const expectedSignature = signer.sign(toSign)
      expect(captured!.signature).toBe(expectedSignature.toHex())
    })

    it("should send data that matches what the signature covers (plain)", async () => {
      const data = new Uint8Array([10, 20, 30, 40])
      const identifier = createTestIdentifier("verify-consistency-plain")

      await uploadSOC(target, signer, identifier, data)

      const captured = capturingFetch.getCaptured()
      expect(captured).toBeDefined()

      // Calculate address from the body that was actually sent
      const actualChunkAddress = calculateChunkAddress(captured!.body)

      // Reconstruct what the signature should cover
      const toSign = Binary.concatBytes(
        identifier.toUint8Array(),
        actualChunkAddress.toUint8Array(),
      )
      const expectedSignature = signer.sign(toSign)

      // The captured signature should match what we'd sign over the sent body
      expect(captured!.signature).toBe(expectedSignature.toHex())
    })
  })

  describe("encrypted SOC signature consistency", () => {
    it("should sign using encrypted chunk address for encrypted SOC", async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      const identifier = createTestIdentifier("test-encrypted-soc")

      const result = await uploadSOC(target, signer, identifier, data, {
        encryptionKey: true,
      })

      expect(result.encryptionKey).toBeDefined()

      const captured = capturingFetch.getCaptured()
      expect(captured).toBeDefined()

      // Verify: body is from encrypted chunk (NOT the same as unencrypted)
      const unencryptedCAC = makeContentAddressedChunk(data)
      expect(captured!.body).not.toEqual(unencryptedCAC.data)

      // Create the same encrypted chunk using the returned key
      const encryptedChunk = makeEncryptedContentAddressedChunk(
        data,
        result.encryptionKey,
      )
      expect(captured!.body).toEqual(encryptedChunk.data)

      // Verify: signature was computed over hash(identifier + encrypted_chunk_address)
      const expectedAddress = encryptedChunk.address.toUint8Array()
      const toSign = Binary.concatBytes(
        identifier.toUint8Array(),
        expectedAddress,
      )
      const expectedSignature = signer.sign(toSign)
      expect(captured!.signature).toBe(expectedSignature.toHex())
    })

    it("should send data that matches what the signature covers (encrypted)", async () => {
      const data = new Uint8Array([100, 200, 50, 25])
      const identifier = createTestIdentifier("verify-consistency-encrypted")

      await uploadSOC(target, signer, identifier, data, {
        encryptionKey: true,
      })

      const captured = capturingFetch.getCaptured()
      expect(captured).toBeDefined()

      // CRITICAL TEST: Calculate address from the body that was actually sent
      const actualChunkAddress = calculateChunkAddress(captured!.body)

      // Reconstruct what the signature should cover
      const toSign = Binary.concatBytes(
        identifier.toUint8Array(),
        actualChunkAddress.toUint8Array(),
      )
      const expectedSignature = signer.sign(toSign)

      // The captured signature should match what we'd sign over the sent body
      // This is the EXACT bug that was introduced: if signature covers different
      // address than the body sent, Bee node rejects with "invalid chunk"
      expect(captured!.signature).toBe(expectedSignature.toHex())
    })

    it("should return encryption key that can decrypt the SOC payload", async () => {
      const originalData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      const identifier = createTestIdentifier("decrypt-round-trip")

      const result = await uploadSOC(target, signer, identifier, originalData, {
        encryptionKey: true,
      })

      expect(result.encryptionKey).toBeDefined()

      const captured = capturingFetch.getCaptured()
      expect(captured).toBeDefined()

      // Decrypt the body using the returned encryption key
      const decrypted = decryptEncryptedChunk(
        captured!.body,
        result.encryptionKey!,
      )

      // Extract the original payload (skip 8-byte span, data is at bytes 8+)
      const decryptedPayload = decrypted.slice(8, 8 + originalData.length)
      expect(decryptedPayload).toEqual(originalData)
    })

    it("should use provided encryption key when specified", async () => {
      const data = new Uint8Array([7, 8, 9, 10])
      const identifier = createTestIdentifier("custom-key")
      const customKey = new Uint8Array(32)
      customKey.fill(42) // Use a deterministic test key

      const result = await uploadSOC(target, signer, identifier, data, {
        encryptionKey: customKey,
      })

      // Should return the same key we provided
      expect(result.encryptionKey).toEqual(customKey)

      const captured = capturingFetch.getCaptured()
      expect(captured).toBeDefined()

      // Create expected encrypted chunk with the custom key
      const encryptedChunk = makeEncryptedContentAddressedChunk(data, customKey)
      expect(captured!.body).toEqual(encryptedChunk.data)
    })
  })

  describe("regression: signature/data mismatch bug", () => {
    /**
     * This is the exact regression test for the bug that was introduced.
     *
     * The bug was:
     * 1. Create unencrypted CAC: address = hash(unencrypted_span + unencrypted_payload)
     * 2. Sign: signature = sign(hash(identifier + address))  [signs UNENCRYPTED address]
     * 3. Encrypt payload and send: body = span + encrypted_payload [sends ENCRYPTED data]
     * 4. Node calculates: received_address = hash(body) [ENCRYPTED address]
     * 5. Node verifies: signature over hash(identifier + received_address)
     * 6. FAILS because signature was over UNENCRYPTED address, not ENCRYPTED
     */
    it("should NOT have signature covering different address than body (the bug)", async () => {
      const data = new Uint8Array([1, 2, 3, 4])
      const identifier = createTestIdentifier("regression-test")

      await uploadSOC(target, signer, identifier, data, {
        encryptionKey: true,
      })

      const captured = capturingFetch.getCaptured()
      expect(captured).toBeDefined()

      // What the BROKEN code would have signed (unencrypted chunk address)
      const unencryptedCAC = makeContentAddressedChunk(data)
      const wrongToSign = Binary.concatBytes(
        identifier.toUint8Array(),
        unencryptedCAC.address.toUint8Array(),
      )
      const wrongSignature = signer.sign(wrongToSign)

      // The captured signature should NOT be the wrong signature
      // If this test fails, it means the signature covers unencrypted address
      // but the body is encrypted, causing "invalid chunk" error
      expect(captured!.signature).not.toBe(wrongSignature.toHex())

      // What the CORRECT code signs (encrypted chunk address = hash of sent body)
      const sentBodyAddress = calculateChunkAddress(captured!.body)
      const correctToSign = Binary.concatBytes(
        identifier.toUint8Array(),
        sentBodyAddress.toUint8Array(),
      )
      const correctSignature = signer.sign(correctToSign)

      // The captured signature SHOULD be the correct signature
      expect(captured!.signature).toBe(correctSignature.toHex())
    })
  })

  describe("edge cases", () => {
    it("should handle minimum payload size (1 byte)", async () => {
      const data = new Uint8Array([42])
      const identifier = createTestIdentifier("min-payload")

      const result = await uploadSOC(target, signer, identifier, data, {
        encryptionKey: true,
      })

      expect(result.encryptionKey).toBeDefined()
      expect(result.socAddress).toBeDefined()

      // Verify signature/data consistency
      const captured = capturingFetch.getCaptured()
      const actualAddress = calculateChunkAddress(captured!.body)
      const toSign = Binary.concatBytes(
        identifier.toUint8Array(),
        actualAddress.toUint8Array(),
      )
      const expectedSig = signer.sign(toSign)
      expect(captured!.signature).toBe(expectedSig.toHex())
    })

    it("should handle maximum payload size (4096 bytes)", async () => {
      const data = new Uint8Array(4096)
      for (let i = 0; i < 4096; i++) {
        data[i] = i % 256
      }
      const identifier = createTestIdentifier("max-payload")

      const result = await uploadSOC(target, signer, identifier, data, {
        encryptionKey: true,
      })

      expect(result.encryptionKey).toBeDefined()

      // Verify signature/data consistency
      const captured = capturingFetch.getCaptured()
      const actualAddress = calculateChunkAddress(captured!.body)
      const toSign = Binary.concatBytes(
        identifier.toUint8Array(),
        actualAddress.toUint8Array(),
      )
      const expectedSig = signer.sign(toSign)
      expect(captured!.signature).toBe(expectedSig.toHex())
    })

    it("should reject payload larger than 4096 bytes", async () => {
      const data = new Uint8Array(4097)
      const identifier = createTestIdentifier("too-large")

      await expect(uploadSOC(target, signer, identifier, data)).rejects.toThrow(
        /Invalid data length.*expected 1-4096/,
      )
    })

    it("should reject empty payload", async () => {
      const data = new Uint8Array(0)
      const identifier = createTestIdentifier("empty")

      await expect(uploadSOC(target, signer, identifier, data)).rejects.toThrow(
        /Invalid data length.*expected 1-4096/,
      )
    })
  })
})

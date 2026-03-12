/**
 * Unit tests for content-addressed chunk (CAC) creation
 */

import { describe, it, expect } from "vitest"
import { Span } from "@ethersphere/bee-js"
import { makeContentAddressedChunk } from "./cac"
import { calculateChunkAddress } from "./bmt"

// ============================================================================
// makeContentAddressedChunk Tests
// ============================================================================

describe("makeContentAddressedChunk", () => {
  describe("chunk structure", () => {
    it("should create chunk with correct structure (data = span + payload)", () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5])
      const chunk = makeContentAddressedChunk(payload)

      // data should be span (8 bytes) + payload
      expect(chunk.data.length).toBe(8 + payload.length)
      expect(chunk.data.slice(8)).toEqual(payload)
    })

    it("should set span reflecting payload length", () => {
      const payload = new Uint8Array([10, 20, 30])
      const chunk = makeContentAddressedChunk(payload)

      expect(chunk.span.toBigInt()).toBe(BigInt(payload.length))
    })

    it("should calculate address matching calculateChunkAddress result", () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      const chunk = makeContentAddressedChunk(payload)

      const expectedAddress = calculateChunkAddress(chunk.data)

      expect(chunk.address.toUint8Array()).toEqual(
        expectedAddress.toUint8Array(),
      )
    })
  })

  describe("string input handling", () => {
    it("should accept string input and encode as UTF-8", () => {
      const text = "Hello, World!"
      const chunk = makeContentAddressedChunk(text)

      const encoder = new TextEncoder()
      const expectedPayload = encoder.encode(text)

      expect(chunk.payload.toUint8Array()).toEqual(expectedPayload)
      expect(chunk.span.toBigInt()).toBe(BigInt(expectedPayload.length))
    })

    it("should handle Unicode strings", () => {
      const text = "Hello, 世界! 🌍"
      const chunk = makeContentAddressedChunk(text)

      const encoder = new TextEncoder()
      const expectedPayload = encoder.encode(text)

      expect(chunk.payload.toUint8Array()).toEqual(expectedPayload)
    })

    it("should handle empty-like strings (single char)", () => {
      const text = "a"
      const chunk = makeContentAddressedChunk(text)

      expect(chunk.span.toBigInt()).toBe(BigInt(1))
    })
  })

  describe("spanOverride parameter", () => {
    it("should use Span override when provided", () => {
      const payload = new Uint8Array([1, 2, 3, 4])
      const customSpan = Span.fromBigInt(BigInt(1000))
      const chunk = makeContentAddressedChunk(payload, customSpan)

      expect(chunk.span.toBigInt()).toBe(BigInt(1000))
    })

    it("should use bigint override when provided", () => {
      const payload = new Uint8Array([1, 2, 3, 4])
      const chunk = makeContentAddressedChunk(payload, BigInt(2000))

      expect(chunk.span.toBigInt()).toBe(BigInt(2000))
    })

    it("should produce different address with different spanOverride", () => {
      const payload = new Uint8Array([1, 2, 3, 4])

      const chunk1 = makeContentAddressedChunk(payload)
      const chunk2 = makeContentAddressedChunk(payload, BigInt(100))

      expect(chunk1.address.toUint8Array()).not.toEqual(
        chunk2.address.toUint8Array(),
      )
    })
  })

  describe("error handling", () => {
    it("should throw error on empty payload", () => {
      const emptyPayload = new Uint8Array(0)

      expect(() => makeContentAddressedChunk(emptyPayload)).toThrow(
        /payload size .* exceeds limits/,
      )
    })

    it("should throw error on empty string", () => {
      expect(() => makeContentAddressedChunk("")).toThrow(
        /payload size .* exceeds limits/,
      )
    })

    it("should throw error on payload larger than 4096 bytes", () => {
      const largePayload = new Uint8Array(4097)

      expect(() => makeContentAddressedChunk(largePayload)).toThrow(
        /payload size .* exceeds limits/,
      )
    })
  })

  describe("determinism", () => {
    it("should produce same chunk for same payload", () => {
      const payload = new Uint8Array([5, 10, 15, 20, 25])

      const chunk1 = makeContentAddressedChunk(payload)
      const chunk2 = makeContentAddressedChunk(payload)

      expect(chunk1.data).toEqual(chunk2.data)
      expect(chunk1.address.toUint8Array()).toEqual(
        chunk2.address.toUint8Array(),
      )
      expect(chunk1.span.toBigInt()).toBe(chunk2.span.toBigInt())
    })

    it("should produce same chunk for same string", () => {
      const text = "Test string for determinism"

      const chunk1 = makeContentAddressedChunk(text)
      const chunk2 = makeContentAddressedChunk(text)

      expect(chunk1.data).toEqual(chunk2.data)
      expect(chunk1.address.toUint8Array()).toEqual(
        chunk2.address.toUint8Array(),
      )
    })
  })

  describe("payload size variations", () => {
    it("should handle minimum payload size (1 byte)", () => {
      const payload = new Uint8Array([42])
      const chunk = makeContentAddressedChunk(payload)

      expect(chunk.span.toBigInt()).toBe(BigInt(1))
      expect(chunk.data.length).toBe(9) // 8 span + 1 payload
    })

    it("should handle maximum payload size (4096 bytes)", () => {
      const payload = new Uint8Array(4096)
      for (let i = 0; i < 4096; i++) {
        payload[i] = i % 256
      }
      const chunk = makeContentAddressedChunk(payload)

      expect(chunk.span.toBigInt()).toBe(BigInt(4096))
      expect(chunk.data.length).toBe(8 + 4096)
    })

    it("should handle power-of-two sizes correctly", () => {
      const sizes = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096]

      for (const size of sizes) {
        const payload = new Uint8Array(size)
        payload.fill(42)
        const chunk = makeContentAddressedChunk(payload)

        expect(chunk.span.toBigInt()).toBe(BigInt(size))
        expect(chunk.address.toUint8Array().length).toBe(32)
      }
    })
  })

  describe("edge cases", () => {
    it("should handle payload with all zeros", () => {
      const payload = new Uint8Array(100)
      const chunk = makeContentAddressedChunk(payload)

      expect(chunk.address.toUint8Array().length).toBe(32)
    })

    it("should handle payload with all 0xFF", () => {
      const payload = new Uint8Array(100).fill(0xff)
      const chunk = makeContentAddressedChunk(payload)

      expect(chunk.address.toUint8Array().length).toBe(32)
    })

    it("should produce different chunks for different payloads", () => {
      const payload1 = new Uint8Array([1, 2, 3])
      const payload2 = new Uint8Array([4, 5, 6])

      const chunk1 = makeContentAddressedChunk(payload1)
      const chunk2 = makeContentAddressedChunk(payload2)

      expect(chunk1.address.toUint8Array()).not.toEqual(
        chunk2.address.toUint8Array(),
      )
    })
  })
})

/**
 * Unit tests for BMT (Binary Merkle Tree) hashing
 */

import { describe, it, expect } from "vitest"
import { Span } from "@ethersphere/bee-js"
import { calculateChunkAddress } from "./bmt"

// ============================================================================
// calculateChunkAddress Tests
// ============================================================================

describe("calculateChunkAddress", () => {
  describe("basic functionality", () => {
    it("should return 32-byte Reference", () => {
      const span = Span.fromBigInt(BigInt(4))
      const payload = new Uint8Array([1, 2, 3, 4])
      const chunkContent = new Uint8Array(8 + payload.length)
      chunkContent.set(span.toUint8Array())
      chunkContent.set(payload, 8)

      const address = calculateChunkAddress(chunkContent)

      expect(address.toUint8Array().length).toBe(32)
    })

    it("should produce deterministic result (same content = same address)", () => {
      const span = Span.fromBigInt(BigInt(5))
      const payload = new Uint8Array([10, 20, 30, 40, 50])
      const chunkContent = new Uint8Array(8 + payload.length)
      chunkContent.set(span.toUint8Array())
      chunkContent.set(payload, 8)

      const address1 = calculateChunkAddress(chunkContent)
      const address2 = calculateChunkAddress(chunkContent)

      expect(address1.toUint8Array()).toEqual(address2.toUint8Array())
    })

    it("should produce different address for different content", () => {
      const span = Span.fromBigInt(BigInt(4))

      const payload1 = new Uint8Array([1, 2, 3, 4])
      const chunkContent1 = new Uint8Array(8 + payload1.length)
      chunkContent1.set(span.toUint8Array())
      chunkContent1.set(payload1, 8)

      const payload2 = new Uint8Array([5, 6, 7, 8])
      const chunkContent2 = new Uint8Array(8 + payload2.length)
      chunkContent2.set(span.toUint8Array())
      chunkContent2.set(payload2, 8)

      const address1 = calculateChunkAddress(chunkContent1)
      const address2 = calculateChunkAddress(chunkContent2)

      expect(address1.toUint8Array()).not.toEqual(address2.toUint8Array())
    })
  })

  describe("payload size handling", () => {
    it("should handle minimum payload (1 byte)", () => {
      const span = Span.fromBigInt(BigInt(1))
      const payload = new Uint8Array([42])
      const chunkContent = new Uint8Array(8 + payload.length)
      chunkContent.set(span.toUint8Array())
      chunkContent.set(payload, 8)

      const address = calculateChunkAddress(chunkContent)

      expect(address.toUint8Array().length).toBe(32)
    })

    it("should handle maximum payload (4096 bytes)", () => {
      const span = Span.fromBigInt(BigInt(4096))
      const payload = new Uint8Array(4096)
      for (let i = 0; i < 4096; i++) {
        payload[i] = i % 256
      }
      const chunkContent = new Uint8Array(8 + payload.length)
      chunkContent.set(span.toUint8Array())
      chunkContent.set(payload, 8)

      const address = calculateChunkAddress(chunkContent)

      expect(address.toUint8Array().length).toBe(32)
    })

    it("should throw error on payload larger than 4096 bytes", () => {
      const span = Span.fromBigInt(BigInt(4097))
      const payload = new Uint8Array(4097)
      const chunkContent = new Uint8Array(8 + payload.length)
      chunkContent.set(span.toUint8Array())
      chunkContent.set(payload, 8)

      expect(() => calculateChunkAddress(chunkContent)).toThrow(
        /payload size .* exceeds maximum chunk payload size/,
      )
    })
  })

  describe("zero-padding behavior", () => {
    it("should produce consistent hash with short payloads (zero-padded internally)", () => {
      // Two chunks with same payload should have same address
      const span = Span.fromBigInt(BigInt(10))
      const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

      const chunkContent = new Uint8Array(8 + payload.length)
      chunkContent.set(span.toUint8Array())
      chunkContent.set(payload, 8)

      const address1 = calculateChunkAddress(chunkContent)
      const address2 = calculateChunkAddress(chunkContent)

      expect(address1.toUint8Array()).toEqual(address2.toUint8Array())
    })

    it("should produce different hash for different payload lengths with same prefix", () => {
      // Payload of length 4 vs length 5 should have different addresses
      const payload4 = new Uint8Array([1, 2, 3, 4])
      const payload5 = new Uint8Array([1, 2, 3, 4, 0])

      const span4 = Span.fromBigInt(BigInt(4))
      const chunkContent4 = new Uint8Array(8 + payload4.length)
      chunkContent4.set(span4.toUint8Array())
      chunkContent4.set(payload4, 8)

      const span5 = Span.fromBigInt(BigInt(5))
      const chunkContent5 = new Uint8Array(8 + payload5.length)
      chunkContent5.set(span5.toUint8Array())
      chunkContent5.set(payload5, 8)

      const address4 = calculateChunkAddress(chunkContent4)
      const address5 = calculateChunkAddress(chunkContent5)

      // Even though payload5 ends with 0 (like zero-padding), different spans mean different addresses
      expect(address4.toUint8Array()).not.toEqual(address5.toUint8Array())
    })
  })

  describe("span variations", () => {
    it("should produce different addresses for same payload but different span", () => {
      const payload = new Uint8Array([1, 2, 3, 4])

      const span1 = Span.fromBigInt(BigInt(4))
      const chunkContent1 = new Uint8Array(8 + payload.length)
      chunkContent1.set(span1.toUint8Array())
      chunkContent1.set(payload, 8)

      // Same payload but span indicates different length
      const span2 = Span.fromBigInt(BigInt(3))
      const chunkContent2 = new Uint8Array(8 + payload.length)
      chunkContent2.set(span2.toUint8Array())
      chunkContent2.set(payload, 8)

      const address1 = calculateChunkAddress(chunkContent1)
      const address2 = calculateChunkAddress(chunkContent2)

      expect(address1.toUint8Array()).not.toEqual(address2.toUint8Array())
    })
  })

  describe("edge cases", () => {
    it("should handle chunk with zero-filled payload", () => {
      const span = Span.fromBigInt(BigInt(32))
      const payload = new Uint8Array(32) // all zeros
      const chunkContent = new Uint8Array(8 + payload.length)
      chunkContent.set(span.toUint8Array())
      chunkContent.set(payload, 8)

      const address = calculateChunkAddress(chunkContent)

      expect(address.toUint8Array().length).toBe(32)
    })

    it("should handle chunk with all 0xFF payload", () => {
      const span = Span.fromBigInt(BigInt(32))
      const payload = new Uint8Array(32).fill(0xff)
      const chunkContent = new Uint8Array(8 + payload.length)
      chunkContent.set(span.toUint8Array())
      chunkContent.set(payload, 8)

      const address = calculateChunkAddress(chunkContent)

      expect(address.toUint8Array().length).toBe(32)
    })

    it("should handle exactly 32 bytes payload (one BMT segment)", () => {
      const span = Span.fromBigInt(BigInt(32))
      const payload = new Uint8Array(32)
      for (let i = 0; i < 32; i++) {
        payload[i] = i
      }
      const chunkContent = new Uint8Array(8 + payload.length)
      chunkContent.set(span.toUint8Array())
      chunkContent.set(payload, 8)

      const address = calculateChunkAddress(chunkContent)

      expect(address.toUint8Array().length).toBe(32)
    })

    it("should handle exactly 64 bytes payload (two BMT segments)", () => {
      const span = Span.fromBigInt(BigInt(64))
      const payload = new Uint8Array(64)
      for (let i = 0; i < 64; i++) {
        payload[i] = i
      }
      const chunkContent = new Uint8Array(8 + payload.length)
      chunkContent.set(span.toUint8Array())
      chunkContent.set(payload, 8)

      const address = calculateChunkAddress(chunkContent)

      expect(address.toUint8Array().length).toBe(32)
    })
  })
})

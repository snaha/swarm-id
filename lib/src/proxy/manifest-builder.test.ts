import { describe, it, expect } from "vitest"
import {
  buildMinimalManifest,
  buildBzzCompatibleManifest,
  extractReferenceFromManifest,
  extractContentFromFlatManifest,
} from "./manifest-builder"

// Test vector from Bee Go: pkg/manifest/mantaray/marshal_test.go
// Valid manifest with "/" fork and metadata
const VALID_MANIFEST_HEX =
  "00000000000000000000000000000000000000000000000000000000000000005768b3b6a7db56d21d1abff40d41cebfc83448fed8d7e9b06ec0d3b073f28f200000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000016012f0000000000000000000000000000000000000000000000000000000000e87f95c3d081c4fede769b6c69e27b435e525cbd25c6715c607e7c531e329639005d7b22776562736974652d696e6465782d646f63756d656e74223a2233356561656538316262363338303436393965633637316265323736326465626665346662643330636461646139303232393239646131613965366134366436227d0a"

// Version hash for v0.2 (current)
const VERSION_02_HASH =
  "5768b3b6a7db56d21d1abff40d41cebfc83448fed8d7e9b06ec0d3b073f28f7b"

describe("manifest-builder", () => {
  describe("buildMinimalManifest", () => {
    it("should create a valid manifest with / fork", () => {
      const contentRef =
        "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00"
      const manifest = buildMinimalManifest(contentRef)

      // Manifest should be exactly 192 bytes (header 128 + fork 64)
      expect(manifest.length).toBe(192)

      // First 32 bytes are obfuscation key (all zeros)
      const obfuscationKey = manifest.slice(0, 32)
      expect(obfuscationKey.every((b) => b === 0)).toBe(true)

      // Bytes 32-62 should contain version hash
      const versionHash = manifest.slice(32, 63)
      expect(uint8ArrayToHex(versionHash)).toBe(VERSION_02_HASH.slice(0, 62))

      // Byte 63 is refBytesCount = 32
      expect(manifest[63]).toBe(32)

      // Bytes 64-95 are entry (all zeros for root)
      const entry = manifest.slice(64, 96)
      expect(entry.every((b) => b === 0)).toBe(true)

      // Bytes 96-127 are index bitmap (bit 47 set for '/')
      const indexBitmap = manifest.slice(96, 128)
      expect(indexBitmap[5]).toBe(0x80) // Byte 5, bit 7 set for '/'
    })

    it("should embed content reference correctly", () => {
      const contentRef =
        "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00"
      const manifest = buildMinimalManifest(contentRef)

      // Fork starts at offset 128
      // Flags at 128 = 0x02 (TYPE_VALUE: has targetAddress)
      expect(manifest[128]).toBe(0x02)

      // PrefixLen at 129 = 1
      expect(manifest[129]).toBe(1)

      // Prefix at 130 = '/' (0x2f)
      expect(manifest[130]).toBe(0x2f)

      // Reference at 160-191
      const reference = manifest.slice(160, 192)
      expect(uint8ArrayToHex(reference)).toBe(contentRef)
    })

    it("should round-trip correctly", () => {
      const contentRef =
        "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00"
      const manifest = buildMinimalManifest(contentRef)
      const extracted = extractReferenceFromManifest(manifest)

      expect(extracted).toBe(contentRef)
    })

    it("should work with different references", () => {
      const refs = [
        "0000000000000000000000000000000000000000000000000000000000000001",
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      ]

      for (const ref of refs) {
        const manifest = buildMinimalManifest(ref)
        const extracted = extractReferenceFromManifest(manifest)
        expect(extracted).toBe(ref)
      }
    })
  })

  describe("extractReferenceFromManifest", () => {
    it("should extract reference from round-trip manifest", () => {
      const contentRef =
        "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00"
      const manifest = buildMinimalManifest(contentRef)

      const extracted = extractReferenceFromManifest(manifest)
      expect(extracted).toBe(contentRef)
    })

    it("should extract reference from Bee Go test vector", () => {
      // Parse the valid manifest from Bee Go tests
      const manifestBytes = hexToUint8Array(VALID_MANIFEST_HEX)

      // The "/" fork reference in this test vector is:
      // e87f95c3d081c4fede769b6c69e27b435e525cbd25c6715c607e7c531e329639
      const extracted = extractReferenceFromManifest(manifestBytes)
      expect(extracted).toBe(
        "e87f95c3d081c4fede769b6c69e27b435e525cbd25c6715c607e7c531e329639",
      )
    })

    it("should throw on manifest too small", () => {
      const smallManifest = new Uint8Array(100)
      expect(() => extractReferenceFromManifest(smallManifest)).toThrow(
        "Manifest too small",
      )
    })

    it("should throw on manifest without / fork", () => {
      // Create a manifest with no "/" fork (index bitmap all zeros)
      const manifest = buildMinimalManifest(
        "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00",
      )
      // Clear the "/" bit in index bitmap
      manifest[96 + 5] = 0x00

      expect(() => extractReferenceFromManifest(manifest)).toThrow(
        'does not contain "/" fork',
      )
    })

    it("should throw on zero reference", () => {
      // Create a manifest with zero reference
      const manifest = buildMinimalManifest(
        "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00",
      )
      // Zero out the reference
      manifest.fill(0, 160, 192)

      expect(() => extractReferenceFromManifest(manifest)).toThrow(
        "zero reference",
      )
    })
  })

  describe("Bee Go compatibility", () => {
    it("should parse manifest with zero obfuscation key", () => {
      // The VALID_MANIFEST_HEX starts with 32 zero bytes (unencrypted)
      const manifestBytes = hexToUint8Array(VALID_MANIFEST_HEX)
      const obfuscationKey = manifestBytes.slice(0, 32)

      // Verify it's all zeros
      expect(obfuscationKey.every((b) => b === 0)).toBe(true)
    })

    it("should recognize v0.2 version hash", () => {
      const manifestBytes = hexToUint8Array(VALID_MANIFEST_HEX)
      // Version hash is at bytes 32-63 (31 bytes, XORed with obfuscation key)
      const versionHash = manifestBytes.slice(32, 63)
      // Since obfuscation key is zero, no XOR needed
      expect(uint8ArrayToHex(versionHash)).toBe(VERSION_02_HASH.slice(0, 62))
    })

    it("should handle Bee Go manifest with metadata", () => {
      // The Bee Go test vector has metadata after the reference
      const manifestBytes = hexToUint8Array(VALID_MANIFEST_HEX)

      // Fork flags: TYPE_VALUE=0x02, TYPE_EDGE=0x04, TYPE_WITH_METADATA=0x10
      // Test vector 0x16 = TYPE_VALUE(2) + TYPE_EDGE(4) + TYPE_WITH_METADATA(16)
      expect(manifestBytes[128]).toBe(0x16)

      // Should still extract the reference correctly
      const extracted = extractReferenceFromManifest(manifestBytes)
      expect(extracted).toBe(
        "e87f95c3d081c4fede769b6c69e27b435e525cbd25c6715c607e7c531e329639",
      )
    })
  })

  describe("binary format verification", () => {
    it("should produce correct binary layout", () => {
      const contentRef =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      const manifest = buildMinimalManifest(contentRef)

      // Verify complete structure
      const hex = uint8ArrayToHex(manifest)

      // Check obfuscation key (32 bytes = 64 hex chars)
      expect(hex.slice(0, 64)).toBe("0".repeat(64))

      // Check version hash starts at byte 32
      expect(hex.slice(64, 66)).toBe("57") // First byte of version hash

      // Check index bitmap has "/" bit set at byte 5
      expect(hex.slice(192 + 10, 192 + 12)).toBe("80")

      // Check fork flags
      expect(hex.slice(256, 258)).toBe("02") // TYPE_VALUE flag (has targetAddress)

      // Check prefix length
      expect(hex.slice(258, 260)).toBe("01")

      // Check prefix '/'
      expect(hex.slice(260, 262)).toBe("2f")

      // Check reference at offset 160 (320 hex chars)
      expect(hex.slice(320, 384)).toBe(contentRef)
    })
  })

  describe("Bee /bzz/ endpoint compatibility", () => {
    it("should use correct TYPE_VALUE flag matching bee-js", () => {
      // Verify our flag matches bee-js TYPE_VALUE = 2
      const contentRef =
        "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00"
      const manifest = buildMinimalManifest(contentRef)
      const forkFlags = manifest[128]

      // TYPE_VALUE = 2 should be set
      expect(forkFlags & 0x02).toBe(0x02)
      // TYPE_WITH_METADATA = 16 should NOT be set (no metadata)
      expect(forkFlags & 0x10).toBe(0)
    })

    it("should not set TYPE_WITH_METADATA flag when no metadata", () => {
      const contentRef =
        "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00"
      const manifest = buildMinimalManifest(contentRef)

      // Fork flags at offset 128 should be exactly 0x02 (TYPE_VALUE only)
      expect(manifest[128]).toBe(0x02)

      // Manifest should end at byte 192 (no metadata bytes after reference)
      expect(manifest.length).toBe(192)
    })

    it("should have valid fork structure for Bee parsing", () => {
      const contentRef =
        "e87f95c3d081c4fede769b6c69e27b435e525cbd25c6715c607e7c531e329639"
      const manifest = buildMinimalManifest(contentRef)

      // Fork structure: flags(1) + prefixLen(1) + prefix(30) + reference(32)
      const forkOffset = 128

      // 1. Flags byte: 0x02 (TYPE_VALUE)
      expect(manifest[forkOffset]).toBe(0x02)

      // 2. Prefix length: 1
      expect(manifest[forkOffset + 1]).toBe(1)

      // 3. First prefix byte: '/' (0x2f)
      expect(manifest[forkOffset + 2]).toBe(0x2f)

      // 4. Remaining prefix bytes: zero-padded (29 bytes)
      for (let i = 3; i < 32; i++) {
        expect(manifest[forkOffset + i]).toBe(0)
      }

      // 5. Reference at offset 160 (forkOffset + 32)
      const refOffset = forkOffset + 32
      const extractedRef = uint8ArrayToHex(
        manifest.slice(refOffset, refOffset + 32),
      )
      expect(extractedRef).toBe(contentRef)
    })

    it("should correctly parse TYPE_VALUE | TYPE_EDGE | TYPE_WITH_METADATA from Bee", () => {
      // Bee Go test vector has flags = 0x16 = TYPE_VALUE(2) + TYPE_EDGE(4) + TYPE_WITH_METADATA(16)
      const manifestBytes = hexToUint8Array(VALID_MANIFEST_HEX)

      // Verify correct flag interpretation
      const flags = manifestBytes[128]
      expect(flags).toBe(0x16)

      // TYPE_VALUE (0x02) should be set
      expect(flags & 0x02).toBe(0x02)
      // TYPE_EDGE (0x04) should be set
      expect(flags & 0x04).toBe(0x04)
      // TYPE_WITH_METADATA (0x10) should be set
      expect(flags & 0x10).toBe(0x10)

      // Despite having all these flags, extraction should still work
      const extracted = extractReferenceFromManifest(manifestBytes)
      expect(extracted).toBe(
        "e87f95c3d081c4fede769b6c69e27b435e525cbd25c6715c607e7c531e329639",
      )
    })
  })
})

describe("buildBzzCompatibleManifest", () => {
  it("should return single manifest chunk (flat structure)", async () => {
    const contentRef =
      "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00"
    const result = await buildBzzCompatibleManifest(contentRef)

    expect(result.manifestChunk).toBeDefined()
    expect(result.manifestChunk.data).toBeInstanceOf(Uint8Array)
    expect(result.manifestChunk.address).toHaveLength(64)
  })

  it("should embed content reference in index.bin fork", async () => {
    const contentRef =
      "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00"
    const result = await buildBzzCompatibleManifest(contentRef)

    // The manifest should contain the content reference
    const manifestHex = uint8ArrayToHex(result.manifestChunk.data)
    expect(manifestHex).toContain(contentRef)
  })

  it("should include website-index-document metadata", async () => {
    const contentRef =
      "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00"
    const result = await buildBzzCompatibleManifest(contentRef)

    const manifestHex = uint8ArrayToHex(result.manifestChunk.data)
    expect(manifestHex).toContain(
      uint8ArrayToHex(new TextEncoder().encode("website-index-document")),
    )
    expect(manifestHex).toContain(
      uint8ArrayToHex(new TextEncoder().encode("index.bin")),
    )
  })

  it("should work with different content references", async () => {
    const refs = [
      "0000000000000000000000000000000000000000000000000000000000000001",
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    ]

    for (const ref of refs) {
      const result = await buildBzzCompatibleManifest(ref)
      expect(result.manifestChunk).toBeDefined()
      // Manifest should contain the content reference
      const manifestHex = uint8ArrayToHex(result.manifestChunk.data)
      expect(manifestHex).toContain(ref)
    }
  })

  it("should throw on invalid reference length", async () => {
    const invalidRef = "abcd" // Too short
    // bee-js Reference constructor throws its own error for invalid length
    await expect(buildBzzCompatibleManifest(invalidRef)).rejects.toThrow()
  })

  it("should accept Uint8Array content reference", async () => {
    const contentRefBytes = hexToUint8Array(
      "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00",
    )
    const result = await buildBzzCompatibleManifest(contentRefBytes)

    expect(result.manifestChunk).toBeDefined()
  })

  it("should produce deterministic output for same input", async () => {
    const contentRef =
      "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00"

    const result1 = await buildBzzCompatibleManifest(contentRef)
    const result2 = await buildBzzCompatibleManifest(contentRef)

    expect(result1.manifestChunk.address).toBe(result2.manifestChunk.address)
  })

  it("should round-trip with extractContentFromFlatManifest", async () => {
    const contentRef =
      "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00"
    const result = await buildBzzCompatibleManifest(contentRef)

    // Extract content reference from flat manifest
    const extracted = extractContentFromFlatManifest(result.manifestChunk.data)
    expect(extracted).toBe(contentRef)
  })
})

describe("extractContentFromFlatManifest", () => {
  it("should extract content reference from flat manifest", async () => {
    const contentRef =
      "f78f17c6da518054b2ced74fb8fffd53a16b70685e3bb706399ceceaf679bd00"
    const result = await buildBzzCompatibleManifest(contentRef)

    const extracted = extractContentFromFlatManifest(result.manifestChunk.data)
    expect(extracted).toBe(contentRef)
  })

  it("should work with different references", async () => {
    const refs = [
      "0000000000000000000000000000000000000000000000000000000000000001",
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    ]

    for (const ref of refs) {
      const result = await buildBzzCompatibleManifest(ref)
      const extracted = extractContentFromFlatManifest(
        result.manifestChunk.data,
      )
      expect(extracted).toBe(ref)
    }
  })

  it("should throw on manifest too small", () => {
    const smallManifest = new Uint8Array(100)
    expect(() => extractContentFromFlatManifest(smallManifest)).toThrow(
      "Manifest too small",
    )
  })
})

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

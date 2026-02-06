/**
 * Unit tests for ACT data structure and serialization (Bee-compatible Simple Manifest JSON format)
 */

import { describe, it, expect } from "vitest"
import {
  serializeAct,
  deserializeAct,
  findEntryByLookupKey,
  publicKeysEqual,
  type ActEntry,
} from "./act"
import { publicKeyFromPrivate } from "./crypto"

// Helper to create a random 32-byte array
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

// Helper to create a test public key
function createTestPublicKey(seed: number): { x: Uint8Array; y: Uint8Array } {
  const privKey = new Uint8Array(32)
  privKey[31] = seed
  return publicKeyFromPrivate(privKey)
}

// Helper to convert bytes to hex
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

describe("serializeAct/deserializeAct (Bee-compatible Simple Manifest JSON format)", () => {
  it("should serialize and deserialize single entry", () => {
    const lookupKey = randomBytes(32)
    const encryptedAccessKey = randomBytes(32)

    const entries: ActEntry[] = [{ lookupKey, encryptedAccessKey }]

    const serialized = serializeAct(entries)
    const deserialized = deserializeAct(serialized)

    expect(deserialized.length).toBe(1)
    expect(deserialized[0].lookupKey).toEqual(lookupKey)
    expect(deserialized[0].encryptedAccessKey).toEqual(encryptedAccessKey)
  })

  it("should handle multiple entries", () => {
    const entries: ActEntry[] = []

    for (let i = 0; i < 5; i++) {
      entries.push({
        lookupKey: randomBytes(32),
        encryptedAccessKey: randomBytes(32),
      })
    }

    const serialized = serializeAct(entries)
    const deserialized = deserializeAct(serialized)

    expect(deserialized.length).toBe(5)
  })

  it("should handle zero entries", () => {
    const entries: ActEntry[] = []

    const serialized = serializeAct(entries)
    const deserialized = deserializeAct(serialized)

    expect(deserialized.length).toBe(0)
  })

  it("should produce valid JSON format", () => {
    const lookupKey = randomBytes(32)
    const encryptedAccessKey = randomBytes(32)

    const entries: ActEntry[] = [{ lookupKey, encryptedAccessKey }]

    const serialized = serializeAct(entries)

    // Should be valid JSON
    const json = new TextDecoder().decode(serialized)
    const parsed = JSON.parse(json)

    // Should have entries object
    expect(parsed).toHaveProperty("entries")
    expect(typeof parsed.entries).toBe("object")

    // Entry key should be hex-encoded lookup key
    const lookupKeyHex = toHex(lookupKey)
    expect(parsed.entries).toHaveProperty(lookupKeyHex)

    // Entry value should have reference (hex-encoded encrypted access key)
    expect(parsed.entries[lookupKeyHex]).toHaveProperty("reference")
    expect(parsed.entries[lookupKeyHex].reference).toBe(
      toHex(encryptedAccessKey),
    )
  })

  it("should handle entries with same lookup key (last wins)", () => {
    const lookupKey = randomBytes(32)
    const encryptedAccessKey1 = randomBytes(32)
    const encryptedAccessKey2 = randomBytes(32)

    // Two entries with same lookup key
    const entries: ActEntry[] = [
      { lookupKey, encryptedAccessKey: encryptedAccessKey1 },
      { lookupKey, encryptedAccessKey: encryptedAccessKey2 },
    ]

    const serialized = serializeAct(entries)
    const deserialized = deserializeAct(serialized)

    // Should only have one entry (second overwrites first)
    expect(deserialized.length).toBe(1)
    expect(deserialized[0].encryptedAccessKey).toEqual(encryptedAccessKey2)
  })

  it("should produce Bee-compatible Simple Manifest structure", () => {
    const lookupKey = new Uint8Array(32)
    lookupKey.fill(0xaa)
    const encryptedAccessKey = new Uint8Array(32)
    encryptedAccessKey.fill(0xbb)

    const entries: ActEntry[] = [{ lookupKey, encryptedAccessKey }]

    const serialized = serializeAct(entries)

    // Parse and check structure matches Bee's Simple Manifest
    const json = new TextDecoder().decode(serialized)
    const manifest = JSON.parse(json)

    // Bee Simple Manifest format:
    // { "entries": { "<path>": { "reference": "<hex>", "metadata": {} } } }
    expect(manifest).toHaveProperty("entries")

    const lookupKeyHex = "aa".repeat(32)
    expect(manifest.entries).toHaveProperty(lookupKeyHex)
    expect(manifest.entries[lookupKeyHex]).toHaveProperty("reference")
    expect(manifest.entries[lookupKeyHex].reference).toBe("bb".repeat(32))
    expect(manifest.entries[lookupKeyHex]).toHaveProperty("metadata")
  })

  it("should handle large number of entries", () => {
    const numEntries = 100
    const entries: ActEntry[] = []
    for (let i = 0; i < numEntries; i++) {
      entries.push({
        lookupKey: randomBytes(32),
        encryptedAccessKey: randomBytes(32),
      })
    }

    const serialized = serializeAct(entries)
    const deserialized = deserializeAct(serialized)

    expect(deserialized.length).toBe(numEntries)
  })

  it("should preserve all data through serialize/deserialize cycle", () => {
    const entries: ActEntry[] = []
    for (let i = 0; i < 10; i++) {
      entries.push({
        lookupKey: randomBytes(32),
        encryptedAccessKey: randomBytes(32),
      })
    }

    const serialized = serializeAct(entries)
    const deserialized = deserializeAct(serialized)

    expect(deserialized.length).toBe(entries.length)

    // Each entry should be found
    for (const entry of entries) {
      const found = findEntryByLookupKey(deserialized, entry.lookupKey)
      expect(found).toBeDefined()
      expect(found?.encryptedAccessKey).toEqual(entry.encryptedAccessKey)
    }
  })
})

describe("findEntryByLookupKey", () => {
  it("should find matching entry", () => {
    const lookupKey1 = randomBytes(32)
    const lookupKey2 = randomBytes(32)
    const lookupKey3 = randomBytes(32)

    const entries: ActEntry[] = [
      { lookupKey: lookupKey1, encryptedAccessKey: randomBytes(32) },
      { lookupKey: lookupKey2, encryptedAccessKey: randomBytes(32) },
      { lookupKey: lookupKey3, encryptedAccessKey: randomBytes(32) },
    ]

    const found = findEntryByLookupKey(entries, lookupKey2)
    expect(found).toBeDefined()
    expect(found?.lookupKey).toEqual(lookupKey2)
  })

  it("should return undefined for non-matching key", () => {
    const entries: ActEntry[] = [
      { lookupKey: randomBytes(32), encryptedAccessKey: randomBytes(32) },
      { lookupKey: randomBytes(32), encryptedAccessKey: randomBytes(32) },
    ]

    const notFound = findEntryByLookupKey(entries, randomBytes(32))
    expect(notFound).toBeUndefined()
  })

  it("should return undefined for empty entries", () => {
    const notFound = findEntryByLookupKey([], randomBytes(32))
    expect(notFound).toBeUndefined()
  })

  it("should match exact bytes only", () => {
    const lookupKey = new Uint8Array(32)
    lookupKey[0] = 0x01
    lookupKey[31] = 0xff

    const entries: ActEntry[] = [
      { lookupKey, encryptedAccessKey: randomBytes(32) },
    ]

    // Same content should match
    const sameContent = new Uint8Array(32)
    sameContent[0] = 0x01
    sameContent[31] = 0xff
    expect(findEntryByLookupKey(entries, sameContent)).toBeDefined()

    // Different content should not match
    const different = new Uint8Array(32)
    different[0] = 0x01
    different[31] = 0xfe // Different!
    expect(findEntryByLookupKey(entries, different)).toBeUndefined()
  })
})

describe("publicKeysEqual", () => {
  it("should return true for equal public keys", () => {
    const key1 = createTestPublicKey(30)
    const key2 = {
      x: new Uint8Array(key1.x),
      y: new Uint8Array(key1.y),
    }

    expect(publicKeysEqual(key1, key2)).toBe(true)
  })

  it("should return false for different x coordinates", () => {
    const key1 = createTestPublicKey(31)
    const key2 = createTestPublicKey(32)

    expect(publicKeysEqual(key1, key2)).toBe(false)
  })

  it("should return false for different y coordinates", () => {
    const key1 = createTestPublicKey(33)
    const key2 = {
      x: new Uint8Array(key1.x), // Same x
      y: randomBytes(32), // Different y
    }

    expect(publicKeysEqual(key1, key2)).toBe(false)
  })

  it("should return false for different lengths", () => {
    const key1 = createTestPublicKey(34)
    const key2 = {
      x: new Uint8Array(16), // Wrong length
      y: key1.y,
    }

    expect(publicKeysEqual(key1, key2)).toBe(false)
  })
})

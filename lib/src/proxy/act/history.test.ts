/**
 * Unit tests for ACT History Management
 */

import { describe, it, expect, vi } from "vitest"
import {
  calculateReversedTimestamp,
  calculateOriginalTimestamp,
  createHistoryManifest,
  addHistoryEntry,
  getLatestEntry,
  getEntryAtTimestamp,
  getAllEntries,
  serializeHistoryTree,
  saveHistoryTreeRecursively,
  deserializeHistory,
  loadHistoryEntries,
  getCurrentTimestamp,
} from "./history"
import { uint8ArrayToHex, hexToUint8Array } from "../../utils/hex"

// Helper to create a random 32-byte hex string
function randomHexRef(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return uint8ArrayToHex(bytes)
}

describe("Timestamp calculations", () => {
  it("calculateReversedTimestamp should reverse timestamp correctly", () => {
    const timestamp = 1700000000
    const reversed = calculateReversedTimestamp(timestamp)

    // MaxInt64 = 9223372036854775807
    // 9223372036854775807 - 1700000000 = 9223372035154775807
    expect(reversed).toBe("9223372035154775807")
  })

  it("calculateOriginalTimestamp should restore original timestamp", () => {
    const original = 1700000000
    const reversed = calculateReversedTimestamp(original)
    const restored = calculateOriginalTimestamp(reversed)

    expect(restored).toBe(original)
  })

  it("reversed timestamps should sort correctly (latest first)", () => {
    const timestamps = [1000, 2000, 3000, 4000, 5000]
    const reversed = timestamps.map(calculateReversedTimestamp)

    // Sort ascending
    reversed.sort((a, b) => a.localeCompare(b))

    // After sorting, convert back to original timestamps
    const sortedOriginals = reversed.map(calculateOriginalTimestamp)

    // Should be sorted descending (latest first)
    expect(sortedOriginals).toEqual([5000, 4000, 3000, 2000, 1000])
  })

  it("should handle edge cases for timestamps", () => {
    // Very small timestamp
    const small = calculateReversedTimestamp(0)
    expect(calculateOriginalTimestamp(small)).toBe(0)

    // Current time range timestamp
    const now = Math.floor(Date.now() / 1000)
    const nowReversed = calculateReversedTimestamp(now)
    expect(calculateOriginalTimestamp(nowReversed)).toBe(now)
  })
})

describe("History manifest operations", () => {
  it("createHistoryManifest should create empty MantarayNode", () => {
    const manifest = createHistoryManifest()
    expect(manifest).toBeDefined()
    expect(manifest.forks.size).toBe(0)
  })

  it("addHistoryEntry should add entry with correct path and reference", () => {
    const manifest = createHistoryManifest()
    const timestamp = 1700000000
    const actReference = randomHexRef()

    addHistoryEntry(manifest, timestamp, actReference)

    // Should have one fork
    expect(manifest.forks.size).toBeGreaterThan(0)

    // Get latest entry and verify
    const latest = getLatestEntry(manifest)
    expect(latest).toBeDefined()
    expect(latest?.timestamp).toBe(timestamp)
    expect(latest?.metadata.actReference).toBe(actReference)
  })

  it("addHistoryEntry should store encryptedGranteeListRef in metadata", () => {
    const manifest = createHistoryManifest()
    const timestamp = 1700000000
    const actReference = randomHexRef()
    const granteeListRef = randomHexRef()

    addHistoryEntry(manifest, timestamp, actReference, granteeListRef)

    const latest = getLatestEntry(manifest)
    expect(latest).toBeDefined()
    expect(latest?.metadata.encryptedGranteeListRef).toBe(granteeListRef)
  })

  it("getLatestEntry should return most recent entry", () => {
    const manifest = createHistoryManifest()

    // Add entries in order
    const ref1 = randomHexRef()
    const ref2 = randomHexRef()
    const ref3 = randomHexRef()

    addHistoryEntry(manifest, 1000, ref1)
    addHistoryEntry(manifest, 2000, ref2)
    addHistoryEntry(manifest, 3000, ref3)

    const latest = getLatestEntry(manifest)
    expect(latest).toBeDefined()
    expect(latest?.timestamp).toBe(3000)
    expect(latest?.metadata.actReference).toBe(ref3)
  })

  it("getLatestEntry should return undefined for empty manifest", () => {
    const manifest = createHistoryManifest()
    const latest = getLatestEntry(manifest)
    expect(latest).toBeUndefined()
  })

  it("getEntryAtTimestamp should find correct entry", () => {
    const manifest = createHistoryManifest()

    const ref1 = randomHexRef()
    const ref2 = randomHexRef()
    const ref3 = randomHexRef()

    addHistoryEntry(manifest, 1000, ref1)
    addHistoryEntry(manifest, 2000, ref2)
    addHistoryEntry(manifest, 3000, ref3)

    // Query exactly at timestamp 2000
    const entry = getEntryAtTimestamp(manifest, 2000)
    expect(entry).toBeDefined()
    expect(entry?.timestamp).toBe(2000)
    expect(entry?.metadata.actReference).toBe(ref2)
  })

  it("getEntryAtTimestamp should find entry at or before timestamp", () => {
    const manifest = createHistoryManifest()

    const ref1 = randomHexRef()
    const ref2 = randomHexRef()

    addHistoryEntry(manifest, 1000, ref1)
    addHistoryEntry(manifest, 3000, ref2)

    // Query at timestamp 2000 (between 1000 and 3000)
    // Should return entry at 1000 (most recent at or before 2000)
    const entry = getEntryAtTimestamp(manifest, 2000)
    expect(entry).toBeDefined()
    expect(entry?.timestamp).toBe(1000)
  })

  it("getAllEntries should return entries sorted newest first", () => {
    const manifest = createHistoryManifest()

    const ref1 = randomHexRef()
    const ref2 = randomHexRef()
    const ref3 = randomHexRef()

    // Add in arbitrary order
    addHistoryEntry(manifest, 2000, ref2)
    addHistoryEntry(manifest, 1000, ref1)
    addHistoryEntry(manifest, 3000, ref3)

    const entries = getAllEntries(manifest)

    expect(entries.length).toBe(3)
    // Should be sorted newest first
    expect(entries[0].timestamp).toBe(3000)
    expect(entries[1].timestamp).toBe(2000)
    expect(entries[2].timestamp).toBe(1000)
  })

  it("getAllEntries should return empty array for empty manifest", () => {
    const manifest = createHistoryManifest()
    const entries = getAllEntries(manifest)
    expect(entries).toEqual([])
  })
})

describe("History serialization", () => {
  it("serializeHistoryTree should produce correct blobs", async () => {
    const manifest = createHistoryManifest()
    addHistoryEntry(manifest, 1000, randomHexRef())

    const result = await serializeHistoryTree(manifest)

    expect(result.blobs.size).toBeGreaterThan(0)
    expect(result.rootReference).toBeDefined()
    expect(result.rootReference.length).toBe(64) // 32 bytes hex
  })

  it("saveHistoryTreeRecursively should upload bottom-up", async () => {
    const manifest = createHistoryManifest()
    addHistoryEntry(manifest, 1000, randomHexRef())
    addHistoryEntry(manifest, 2000, randomHexRef())

    const uploads: { data: Uint8Array; isRoot: boolean }[] = []

    const uploadFn = vi.fn(async (data: Uint8Array, isRoot: boolean) => {
      uploads.push({ data, isRoot })
      // Return a mock reference based on content
      const hash = new Uint8Array(32)
      for (let i = 0; i < Math.min(data.length, 32); i++) {
        hash[i] = data[i]
      }
      return { reference: uint8ArrayToHex(hash), tagUid: 123 }
    })

    const result = await saveHistoryTreeRecursively(manifest, uploadFn)

    // Should have uploaded at least one node
    expect(uploadFn).toHaveBeenCalled()
    expect(result.rootReference).toBeDefined()
    expect(result.tagUid).toBe(123)

    // Last upload should be the root
    expect(uploads[uploads.length - 1].isRoot).toBe(true)
  })

  it("deserializeHistory should parse MantarayNode format", async () => {
    const manifest = createHistoryManifest()
    const actRef = randomHexRef()
    addHistoryEntry(manifest, 1000, actRef)

    // Serialize
    const serialized = await serializeHistoryTree(manifest)

    // Deserialize root
    const selfAddress = hexToUint8Array(serialized.rootReference)
    const rootData = serialized.blobs.get(serialized.rootReference)
    expect(rootData).toBeDefined()

    const deserialized = deserializeHistory(rootData!, selfAddress)
    expect(deserialized).toBeDefined()
    expect(deserialized.forks.size).toBeGreaterThan(0)
  })

  it("loadHistoryEntries should load child nodes recursively", async () => {
    const manifest = createHistoryManifest()
    const actRef = randomHexRef()
    const granteeListRef = randomHexRef()
    addHistoryEntry(manifest, 1000, actRef, granteeListRef)

    // Serialize
    const serialized = await serializeHistoryTree(manifest)

    // Deserialize root
    const selfAddress = hexToUint8Array(serialized.rootReference)
    const rootData = serialized.blobs.get(serialized.rootReference)!
    const deserialized = deserializeHistory(rootData, selfAddress)

    // Load children
    await loadHistoryEntries(deserialized, async (ref) => {
      const data = serialized.blobs.get(ref)
      if (!data) {
        throw new Error(`Data not found for reference: ${ref}`)
      }
      return data
    })

    // Now should be able to get entries
    const entry = getLatestEntry(deserialized)
    expect(entry).toBeDefined()
    expect(entry?.timestamp).toBe(1000)
    expect(entry?.metadata.actReference).toBe(actRef)
    expect(entry?.metadata.encryptedGranteeListRef).toBe(granteeListRef)
  })
})

describe("getCurrentTimestamp", () => {
  it("should return current Unix timestamp in seconds", () => {
    const before = Math.floor(Date.now() / 1000)
    const timestamp = getCurrentTimestamp()
    const after = Math.floor(Date.now() / 1000)

    expect(timestamp).toBeGreaterThanOrEqual(before)
    expect(timestamp).toBeLessThanOrEqual(after)
  })
})

describe("History roundtrip", () => {
  it("should preserve all data through serialize/deserialize/load cycle", async () => {
    const manifest = createHistoryManifest()

    // Add multiple entries with metadata
    const entries = [
      {
        timestamp: 1000,
        actRef: randomHexRef(),
        granteeListRef: randomHexRef(),
      },
      {
        timestamp: 2000,
        actRef: randomHexRef(),
        granteeListRef: randomHexRef(),
      },
      {
        timestamp: 3000,
        actRef: randomHexRef(),
        granteeListRef: randomHexRef(),
      },
    ]

    for (const e of entries) {
      addHistoryEntry(manifest, e.timestamp, e.actRef, e.granteeListRef)
    }

    // Serialize
    const serialized = await serializeHistoryTree(manifest)

    // Deserialize
    const selfAddress = hexToUint8Array(serialized.rootReference)
    const rootData = serialized.blobs.get(serialized.rootReference)!
    const deserialized = deserializeHistory(rootData, selfAddress)

    // Load children
    await loadHistoryEntries(deserialized, async (ref) => {
      const data = serialized.blobs.get(ref)
      if (!data) {
        throw new Error(`Data not found for reference: ${ref}`)
      }
      return data
    })

    // Verify all entries are present
    const allEntries = getAllEntries(deserialized)
    expect(allEntries.length).toBe(3)

    // Verify entries are sorted newest first
    expect(allEntries[0].timestamp).toBe(3000)
    expect(allEntries[1].timestamp).toBe(2000)
    expect(allEntries[2].timestamp).toBe(1000)

    // Verify metadata is preserved
    for (const original of entries) {
      const found = allEntries.find((e) => e.timestamp === original.timestamp)
      expect(found).toBeDefined()
      expect(found?.metadata.actReference).toBe(original.actRef)
      expect(found?.metadata.encryptedGranteeListRef).toBe(
        original.granteeListRef,
      )
    }
  })
})

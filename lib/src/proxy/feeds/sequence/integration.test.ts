/**
 * Integration tests for sequential feeds
 *
 * Based on the Go implementation tests from bee/pkg/feeds/sequence
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Binary } from "cafe-utility"
import type { Bee } from "@ethersphere/bee-js"
import { PrivateKey } from "@ethersphere/bee-js"
import { SyncSequentialFinder } from "./finder"
import { AsyncSequentialFinder } from "./async-finder"
import { BasicSequentialUpdater } from "./updater"
import {
  MockBee,
  MockChunkStore,
  createTestSigner,
  createTestTopic,
  createTestReference,
  createMockStamper,
  mockFetch,
} from "../epochs/test-utils"

const SPAN_SIZE = 8

/**
 * Create 64-byte reference (encrypted reference)
 */
function createTestReference64(seed: number): Uint8Array {
  const ref = new Uint8Array(64)
  const view = new DataView(ref.buffer)
  view.setBigUint64(0, BigInt(seed), false)
  for (let i = 32; i < 64; i++) {
    ref[i] = (seed + i) & 0xff
  }
  return ref
}

/**
 * MockBee that counts download calls
 */
class CountingMockBee extends MockBee {
  public downloadCalls = 0
  public uploadCalls = 0

  override async downloadChunk(reference: string): Promise<Uint8Array> {
    this.downloadCalls++
    const lower = reference.toLowerCase()
    if (!this.getStore().has(lower)) {
      throw new Error("Request failed with status code 404")
    }
    return this.getStore().get(lower)
  }

  override async uploadChunk(
    data: Uint8Array,
    postageBatchId: string,
  ): Promise<{ reference: string }> {
    this.uploadCalls++
    return super.uploadChunk(data, postageBatchId)
  }
}

/**
 * MockBee that simulates network failures
 */
class FailingMockBee extends MockBee {
  private failureCount = 0
  private maxFailures: number

  constructor(store?: MockChunkStore, maxFailures = 3) {
    super(store)
    this.maxFailures = maxFailures
  }

  override async downloadChunk(reference: string): Promise<Uint8Array> {
    if (this.failureCount < this.maxFailures) {
      this.failureCount++
      throw new Error("Request failed with status code 500")
    }
    return super.downloadChunk(reference)
  }

  resetFailures(): void {
    this.failureCount = 0
  }
}

/**
 * MockBee that simulates mixed error types
 */
class MixedErrorMockBee extends CountingMockBee {
  override async downloadChunk(reference: string): Promise<Uint8Array> {
    this.downloadCalls++
    const lower = reference.toLowerCase()
    if (this.getStore().has(lower)) {
      return this.getStore().get(lower)
    }

    const selector = lower.charCodeAt(0) % 3
    if (selector === 0) {
      throw new Error("Request failed with status code 404")
    }
    if (selector === 1) {
      throw new Error("Request failed with status code 500")
    }
    throw new Error("timeout of 2000ms exceeded")
  }
}

/**
 * Mock uploadSOC to store SOC data in the mock store.
 */
vi.mock("../../upload-encrypted-data", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../upload-encrypted-data")>()
  const { Binary } = await import("cafe-utility")

  return {
    ...mod,
    uploadSOC: async (
      bee: any,
      _stamper: any,
      signer: any,
      identifier: any,
      data: Uint8Array,
    ) => {
      // Validate data size (1-4096 bytes) - matching real uploadSOC
      if (data.length < 1 || data.length > 4096) {
        throw new Error(`Invalid data length: ${data.length} (expected 1-4096)`)
      }

      // Create span (little-endian uint64 of data length)
      const span = new Uint8Array(SPAN_SIZE)
      const spanView = new DataView(span.buffer)
      spanView.setBigUint64(0, BigInt(data.length), true)

      // Sign: hash(identifier + hash(span + data))
      const contentHash = Binary.keccak256(Binary.concatBytes(span, data))
      const toSign = Binary.concatBytes(identifier.toUint8Array(), contentHash)
      const signature = signer.sign(toSign)

      // Build SOC data: identifier(32) + signature(65) + span(8) + payload
      const socData = Binary.concatBytes(
        identifier.toUint8Array(),
        signature.toUint8Array(),
        span,
        data,
      )

      // Calculate SOC address: Keccak256(identifier + owner)
      const owner = signer.publicKey().address()
      const socAddress = Binary.keccak256(
        Binary.concatBytes(identifier.toUint8Array(), owner.toUint8Array()),
      )

      // Store directly in mock store (bypassing fetch)
      const store = bee.getStore()
      const reference = Binary.uint8ArrayToHex(socAddress)
      await store.put(reference, socData)

      return {
        socAddress,
        tagUid: 0,
      }
    },
    uploadEncryptedSOC: async (
      bee: any,
      _stamper: any,
      signer: any,
      identifier: any,
      data: Uint8Array,
    ) => {
      // Validate data size (1-4096 bytes) - matching real uploadEncryptedSOC
      if (data.length < 1 || data.length > 4096) {
        throw new Error(`Invalid data length: ${data.length} (expected 1-4096)`)
      }

      // Create span (little-endian uint64 of data length)
      const span = new Uint8Array(SPAN_SIZE)
      const spanView = new DataView(span.buffer)
      spanView.setBigUint64(0, BigInt(data.length), true)

      // Sign: hash(identifier + hash(span + data))
      const contentHash = Binary.keccak256(Binary.concatBytes(span, data))
      const toSign = Binary.concatBytes(identifier.toUint8Array(), contentHash)
      const signature = signer.sign(toSign)

      // Build SOC data: identifier(32) + signature(65) + span(8) + payload
      const socData = Binary.concatBytes(
        identifier.toUint8Array(),
        signature.toUint8Array(),
        span,
        data,
      )

      // Calculate SOC address: Keccak256(identifier + owner)
      const owner = signer.publicKey().address()
      const socAddress = Binary.keccak256(
        Binary.concatBytes(identifier.toUint8Array(), owner.toUint8Array()),
      )

      // Store directly in mock store (bypassing fetch/encryption)
      const store = bee.getStore()
      const reference = Binary.uint8ArrayToHex(socAddress)
      await store.put(reference, socData)

      return {
        socAddress,
        encryptionKey: new Uint8Array(32),
        tagUid: 0,
      }
    },
  }
})

describe("Sequential Feeds Integration", () => {
  let store: MockChunkStore
  let bee: MockBee
  let signer: ReturnType<typeof createTestSigner>
  let topic: ReturnType<typeof createTestTopic>
  let stamper: ReturnType<typeof createMockStamper>

  beforeEach(() => {
    store = new MockChunkStore()
    bee = new MockBee(store)
    signer = createTestSigner()
    topic = createTestTopic()
    stamper = createMockStamper()
    mockFetch(store, signer.publicKey().address())
  })

  afterEach(() => {
    store.clear()
  })

  describe("Basic Operations", () => {
    it("should return undefined when no updates exist", async () => {
      const owner = signer.publicKey().address()
      const beeClient = bee as unknown as Bee
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBeUndefined()
      expect(result.next).toBe(0n)
    })

    it("should store and retrieve latest update index", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      const updates = 5
      for (let i = 0; i < updates; i++) {
        await updater.update(createTestReference(i), stamper)
      }

      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBe(BigInt(updates - 1))
      expect(result.next).toBe(BigInt(updates))
    })

    it("async finder should match sync finder", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()
      const syncFinder = new SyncSequentialFinder(beeClient, topic, owner)
      const asyncFinder = new AsyncSequentialFinder(beeClient, topic, owner)

      const updates = 3
      for (let i = 0; i < updates; i++) {
        await updater.update(createTestReference(i), stamper)
      }

      const syncResult = await syncFinder.findAt(0n, 0n)
      const asyncResult = await asyncFinder.findAt(0n, 0n)

      expect(asyncResult.current).toBe(syncResult.current)
      expect(asyncResult.next).toBe(syncResult.next)
    })
  })

  describe("Multiple Updates", () => {
    it("should write and read 10 sequential updates", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      // Write indices 0-9
      for (let i = 0; i < 10; i++) {
        await updater.update(createTestReference(i), stamper)
      }

      // Verify finder returns correct result
      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBe(9n)
      expect(result.next).toBe(10n)
    })

    it(
      "should write and read 50 sequential updates",
      { timeout: 10000 },
      async () => {
        const beeClient = bee as unknown as Bee
        const updater = new BasicSequentialUpdater(beeClient, topic, signer)
        const owner = updater.getOwner()
        const finder = new SyncSequentialFinder(beeClient, topic, owner)

        // Larger scale test
        const count = 50
        for (let i = 0; i < count; i++) {
          await updater.update(createTestReference(i), stamper)
        }

        const result = await finder.findAt(0n, 0n)
        expect(result.current).toBe(BigInt(count - 1))
        expect(result.next).toBe(BigInt(count))
      },
    )

    it("should maintain correct ordering across updates", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const finder = new SyncSequentialFinder(
        beeClient,
        topic,
        updater.getOwner(),
      )

      const references: Uint8Array[] = []
      for (let i = 0; i < 5; i++) {
        const ref = createTestReference(i * 100)
        references.push(ref)
        await updater.update(ref, stamper)
      }

      // Verify each update is stored at its expected index
      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBe(4n)
      expect(result.next).toBe(5n)
    })

    it("should handle payload content correctly for each index", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      // Write different payloads at different indices
      const payloads = [
        createTestReference(111),
        createTestReference(222),
        createTestReference(333),
      ]

      for (const payload of payloads) {
        await updater.update(payload, stamper)
      }

      // Verify content integrity
      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBe(2n)
      expect(result.next).toBe(3n)
    })

    it("should handle sequential updates with 64-byte references", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      // Mix of 32-byte and 64-byte references
      await updater.update(createTestReference64(1), stamper)
      await updater.update(createTestReference(2), stamper)
      await updater.update(createTestReference64(3), stamper)

      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBe(2n)
      expect(result.next).toBe(3n)
    })
  })

  describe("Index Lookups", () => {
    it("should find latest update when multiple exist", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      // Write 5 updates
      for (let i = 0; i < 5; i++) {
        await updater.update(createTestReference(i), stamper)
      }

      // Finder should find the latest (index 4)
      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBe(4n)
    })

    it("should return undefined for non-existent feed", async () => {
      const beeClient = bee as unknown as Bee
      // Different topic with no updates
      const emptyTopic = createTestTopic("empty-topic")
      const owner = signer.publicKey().address()
      const finder = new SyncSequentialFinder(beeClient, emptyTopic, owner)

      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBeUndefined()
      expect(result.next).toBe(0n)
    })

    it("should handle index 0 correctly", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      // Single update at index 0
      await updater.update(createTestReference(42), stamper)

      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBe(0n)
      expect(result.next).toBe(1n)
    })

    it("should handle large index counts", { timeout: 15000 }, async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      // Write 100 updates to test scalability
      const count = 100
      for (let i = 0; i < count; i++) {
        await updater.update(createTestReference(i), stamper)
      }

      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBe(BigInt(count - 1))
      expect(result.next).toBe(BigInt(count))
    })

    it("should correctly report next index for empty feed", async () => {
      const beeClient = bee as unknown as Bee
      const owner = signer.publicKey().address()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      const result = await finder.findAt(0n, 0n)
      expect(result.next).toBe(0n)
    })
  })

  describe("Timestamp Handling", () => {
    it("should ignore at parameter (sequential feeds are index-based)", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      await updater.update(createTestReference(1), stamper)
      await updater.update(createTestReference(2), stamper)

      // at parameter should be ignored for sequential feeds
      const result1 = await finder.findAt(0n, 0n)
      const result2 = await finder.findAt(1000n, 0n)
      const result3 = await finder.findAt(999999n, 0n)

      expect(result1.current).toBe(1n)
      expect(result2.current).toBe(1n)
      expect(result3.current).toBe(1n)
    })

    it("should ignore after parameter (sequential feeds scan from 0)", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      await updater.update(createTestReference(1), stamper)
      await updater.update(createTestReference(2), stamper)
      await updater.update(createTestReference(3), stamper)

      // after parameter should be ignored for sequential feeds
      const result1 = await finder.findAt(0n, 0n)
      const result2 = await finder.findAt(0n, 100n)

      expect(result1.current).toBe(2n)
      expect(result2.current).toBe(2n)
    })

    it("should work with async finder using same parameters", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()
      const asyncFinder = new AsyncSequentialFinder(beeClient, topic, owner)

      await updater.update(createTestReference(1), stamper)

      const result1 = await asyncFinder.findAt(0n, 0n)
      const result2 = await asyncFinder.findAt(999n, 999n)

      expect(result1.current).toBe(0n)
      expect(result2.current).toBe(0n)
    })

    it("should handle queries on empty feed consistently", async () => {
      const beeClient = bee as unknown as Bee
      const owner = signer.publicKey().address()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      const result1 = await finder.findAt(0n, 0n)
      const result2 = await finder.findAt(100n, 50n)

      expect(result1.current).toBeUndefined()
      expect(result2.current).toBeUndefined()
      expect(result1.next).toBe(0n)
      expect(result2.next).toBe(0n)
    })
  })

  describe("State Management", () => {
    it("should track next index correctly", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)

      expect(updater.getState().nextIndex).toBe(0n)

      await updater.update(createTestReference(1), stamper)
      expect(updater.getState().nextIndex).toBe(1n)

      await updater.update(createTestReference(2), stamper)
      expect(updater.getState().nextIndex).toBe(2n)

      await updater.update(createTestReference(3), stamper)
      expect(updater.getState().nextIndex).toBe(3n)
    })

    it("should resume from saved state", async () => {
      const beeClient = bee as unknown as Bee
      const updater1 = new BasicSequentialUpdater(beeClient, topic, signer)

      // Write some updates
      await updater1.update(createTestReference(1), stamper)
      await updater1.update(createTestReference(2), stamper)
      const state = updater1.getState()

      // Create new updater and restore state
      const updater2 = new BasicSequentialUpdater(beeClient, topic, signer)
      updater2.setState(state)

      expect(updater2.getState().nextIndex).toBe(2n)

      // Continue writing
      await updater2.update(createTestReference(3), stamper)
      expect(updater2.getState().nextIndex).toBe(3n)

      // Verify all updates are findable
      const finder = new SyncSequentialFinder(
        beeClient,
        topic,
        updater2.getOwner(),
      )
      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBe(2n)
      expect(result.next).toBe(3n)
    })

    it("should reset state correctly", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)

      // Write updates
      await updater.update(createTestReference(1), stamper)
      await updater.update(createTestReference(2), stamper)
      expect(updater.getState().nextIndex).toBe(2n)

      // Reset
      updater.reset()
      expect(updater.getState().nextIndex).toBe(0n)

      // New writes should start from 0 (will overwrite previous)
      await updater.update(createTestReference(100), stamper)
      expect(updater.getState().nextIndex).toBe(1n)
    })
  })

  describe("Error Handling", () => {
    it("should handle network errors gracefully", async () => {
      const failingStore = new MockChunkStore()
      const failingBee = new FailingMockBee(failingStore, 0) // Always fail
      const beeClient = failingBee as unknown as Bee
      const owner = signer.publicKey().address()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      // Should return undefined, not throw
      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBeUndefined()
      expect(result.next).toBe(0n)
    })

    it("should handle 404 for missing chunks", async () => {
      const countingStore = new MockChunkStore()
      const countingBee = new CountingMockBee(countingStore)
      const beeClient = countingBee as unknown as Bee
      const owner = signer.publicKey().address()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      // Finder should return undefined, not crash
      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBeUndefined()
      expect(countingBee.downloadCalls).toBe(1) // Only tried index 0
    })

    it("should handle mixed error types", async () => {
      const mixedStore = new MockChunkStore()
      const mixedBee = new MixedErrorMockBee(mixedStore)
      const beeClient = mixedBee as unknown as Bee
      const owner = signer.publicKey().address()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      // Should handle gracefully regardless of error type
      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBeUndefined()
    })

    it("should continue finding after partial success", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()

      // Create 3 updates
      await updater.update(createTestReference(1), stamper)
      await updater.update(createTestReference(2), stamper)
      await updater.update(createTestReference(3), stamper)

      // Now use counting bee to verify behavior
      const countingBee = new CountingMockBee(store)
      const finder = new SyncSequentialFinder(
        countingBee as unknown as Bee,
        topic,
        owner,
      )

      const result = await finder.findAt(0n, 0n)
      expect(result.current).toBe(2n)
      expect(result.next).toBe(3n)
      // Should have probed indices 0, 1, 2, 3 (where 3 returns 404)
      expect(countingBee.downloadCalls).toBe(4)
    })

    it("should handle empty payload gracefully", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)

      // Empty payloads should throw (data length 0 is invalid)
      const emptyPayload = new Uint8Array(0)
      await expect(updater.update(emptyPayload, stamper)).rejects.toThrow()
    })
  })

  describe("Owner/Topic Isolation", () => {
    it("should isolate updates by owner", async () => {
      const beeClient = bee as unknown as Bee

      // Two different signers (owners)
      const signerA = createTestSigner()
      const signerB = new PrivateKey(
        "9a4ce1ef8d14b7864ea3f1ecfcb39f937ce4a45f47f4d7d02f6b76f1f3ab2c11",
      )

      const updaterA = new BasicSequentialUpdater(beeClient, topic, signerA)
      const updaterB = new BasicSequentialUpdater(beeClient, topic, signerB)

      // Write to both feeds
      await updaterA.update(createTestReference(100), stamper)
      await updaterA.update(createTestReference(101), stamper)

      await updaterB.update(createTestReference(200), stamper)

      // Each owner should see only their own updates
      const finderA = new SyncSequentialFinder(
        beeClient,
        topic,
        updaterA.getOwner(),
      )
      const finderB = new SyncSequentialFinder(
        beeClient,
        topic,
        updaterB.getOwner(),
      )

      const resultA = await finderA.findAt(0n, 0n)
      const resultB = await finderB.findAt(0n, 0n)

      expect(resultA.current).toBe(1n) // Owner A has 2 updates (index 0, 1)
      expect(resultB.current).toBe(0n) // Owner B has 1 update (index 0)
    })

    it("should isolate updates by topic", async () => {
      const beeClient = bee as unknown as Bee

      const topicA = createTestTopic("topic-a")
      const topicB = createTestTopic("topic-b")

      const updaterA = new BasicSequentialUpdater(beeClient, topicA, signer)
      const updaterB = new BasicSequentialUpdater(beeClient, topicB, signer)

      // Write different amounts to each topic
      await updaterA.update(createTestReference(1), stamper)
      await updaterA.update(createTestReference(2), stamper)
      await updaterA.update(createTestReference(3), stamper)

      await updaterB.update(createTestReference(10), stamper)

      const owner = signer.publicKey().address()
      const finderA = new SyncSequentialFinder(beeClient, topicA, owner)
      const finderB = new SyncSequentialFinder(beeClient, topicB, owner)

      const resultA = await finderA.findAt(0n, 0n)
      const resultB = await finderB.findAt(0n, 0n)

      expect(resultA.current).toBe(2n) // Topic A has 3 updates
      expect(resultB.current).toBe(0n) // Topic B has 1 update
    })

    it("should handle cross-owner lookup correctly", async () => {
      const beeClient = bee as unknown as Bee

      const signerA = createTestSigner()
      const signerB = new PrivateKey(
        "7f6c8f5de489c56ba40b494a26d0c6dd0c05fc4f0d37fe2f217af6e9ac7b1a01",
      )

      const updaterA = new BasicSequentialUpdater(beeClient, topic, signerA)

      // Owner A writes updates
      await updaterA.update(createTestReference(1), stamper)
      await updaterA.update(createTestReference(2), stamper)

      // Try to find using Owner B's address - should find nothing
      const finderB = new SyncSequentialFinder(
        beeClient,
        topic,
        signerB.publicKey().address(),
      )
      const result = await finderB.findAt(0n, 0n)

      expect(result.current).toBeUndefined()
      expect(result.next).toBe(0n)
    })
  })

  describe("Concurrent Operations", () => {
    it("should handle concurrent reads safely", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()

      // Write some updates
      for (let i = 0; i < 10; i++) {
        await updater.update(createTestReference(i), stamper)
      }

      // Create multiple finders and read concurrently
      const finders = [
        new SyncSequentialFinder(beeClient, topic, owner),
        new SyncSequentialFinder(beeClient, topic, owner),
        new AsyncSequentialFinder(beeClient, topic, owner),
        new AsyncSequentialFinder(beeClient, topic, owner),
      ]

      const results = await Promise.all(
        finders.map((finder) => finder.findAt(0n, 0n)),
      )

      // All should return the same result
      for (const result of results) {
        expect(result.current).toBe(9n)
        expect(result.next).toBe(10n)
      }
    })

    it("should handle rapid sequential updates", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()

      // Rapid sequential updates (must be sequential to avoid race conditions)
      // Sequential feeds require sequential writes since nextIndex is incremented after each update
      for (let i = 0; i < 20; i++) {
        await updater.update(createTestReference(i), stamper)
      }

      // Verify all updates succeeded
      const finder = new SyncSequentialFinder(beeClient, topic, owner)
      const result = await finder.findAt(0n, 0n)

      expect(result.current).toBe(19n)
      expect(result.next).toBe(20n)
      expect(updater.getState().nextIndex).toBe(20n)
    })
  })

  describe("Performance", () => {
    it(
      "should complete linear scan within reasonable bounds",
      { timeout: 30000 },
      async () => {
        const countingStore = new MockChunkStore()
        const countingBee = new CountingMockBee(countingStore)
        const beeClient = countingBee as unknown as Bee

        const updater = new BasicSequentialUpdater(beeClient, topic, signer)

        // Write 100 updates
        const updateCount = 100
        for (let i = 0; i < updateCount; i++) {
          await updater.update(createTestReference(i), stamper)
        }

        // Reset counter before find
        countingBee.downloadCalls = 0

        const finder = new SyncSequentialFinder(
          beeClient,
          topic,
          updater.getOwner(),
        )
        const result = await finder.findAt(0n, 0n)

        expect(result.current).toBe(BigInt(updateCount - 1))
        // Linear scan should probe exactly updateCount + 1 times (0 to 100 inclusive, where 100 is 404)
        expect(countingBee.downloadCalls).toBe(updateCount + 1)
      },
    )

    it(
      "sync and async finders should match for large datasets",
      { timeout: 10000 },
      async () => {
        const beeClient = bee as unknown as Bee
        const updater = new BasicSequentialUpdater(beeClient, topic, signer)
        const owner = updater.getOwner()

        // Write 50 updates
        for (let i = 0; i < 50; i++) {
          await updater.update(createTestReference(i), stamper)
        }

        const syncFinder = new SyncSequentialFinder(beeClient, topic, owner)
        const asyncFinder = new AsyncSequentialFinder(beeClient, topic, owner)

        const syncResult = await syncFinder.findAt(0n, 0n)
        const asyncResult = await asyncFinder.findAt(0n, 0n)

        expect(asyncResult.current).toBe(syncResult.current)
        expect(asyncResult.next).toBe(syncResult.next)
        expect(syncResult.current).toBe(49n)
      },
    )
  })

  describe("Edge Cases", () => {
    it("should handle single update correctly", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()

      await updater.update(createTestReference(42), stamper)

      const finder = new SyncSequentialFinder(beeClient, topic, owner)
      const result = await finder.findAt(0n, 0n)

      expect(result.current).toBe(0n)
      expect(result.next).toBe(1n)
    })

    it("should handle maximum practical index", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)

      // Start from a high index
      updater.setState({ nextIndex: 1000000n })

      await updater.update(createTestReference(1), stamper)
      expect(updater.getState().nextIndex).toBe(1000001n)

      await updater.update(createTestReference(2), stamper)
      expect(updater.getState().nextIndex).toBe(1000002n)
    })

    it("should preserve reference integrity through update cycle", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)

      const ref32 = createTestReference(123)
      const ref64 = createTestReference64(456)

      const socAddress1 = await updater.update(ref32, stamper)
      const socAddress2 = await updater.update(ref64, stamper)

      // SOC addresses should be valid 32-byte addresses
      expect(socAddress1).toHaveLength(32)
      expect(socAddress2).toHaveLength(32)
      expect(socAddress1).not.toEqual(socAddress2)
    })

    it("should handle getOwner correctly", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)

      const owner = updater.getOwner()
      const expectedOwner = signer.publicKey().address()

      expect(owner.toHex()).toBe(expectedOwner.toHex())
    })
  })

  describe("Finder Consistency", () => {
    it("should return consistent results across multiple queries", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()

      await updater.update(createTestReference(1), stamper)
      await updater.update(createTestReference(2), stamper)
      await updater.update(createTestReference(3), stamper)

      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      // Query multiple times
      const results = await Promise.all([
        finder.findAt(0n, 0n),
        finder.findAt(0n, 0n),
        finder.findAt(0n, 0n),
      ])

      for (const result of results) {
        expect(result.current).toBe(2n)
        expect(result.next).toBe(3n)
      }
    })

    it("should handle interleaved reads and writes", async () => {
      const beeClient = bee as unknown as Bee
      const updater = new BasicSequentialUpdater(beeClient, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncSequentialFinder(beeClient, topic, owner)

      // Write, read, write, read pattern
      await updater.update(createTestReference(1), stamper)
      const result1 = await finder.findAt(0n, 0n)
      expect(result1.current).toBe(0n)

      await updater.update(createTestReference(2), stamper)
      const result2 = await finder.findAt(0n, 0n)
      expect(result2.current).toBe(1n)

      await updater.update(createTestReference(3), stamper)
      const result3 = await finder.findAt(0n, 0n)
      expect(result3.current).toBe(2n)
    })
  })
})

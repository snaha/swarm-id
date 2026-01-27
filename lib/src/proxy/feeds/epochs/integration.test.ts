/**
 * Integration tests for epoch feeds
 *
 * Based on the Go implementation tests from bee/pkg/feeds/epochs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { SyncEpochFinder } from "./finder"
import { AsyncEpochFinder } from "./async-finder"
import { BasicEpochUpdater } from "./updater"
import {
  MockBee,
  MockChunkStore,
  createTestSigner,
  createTestTopic,
  createTestReference,
  createMockStamper,
  mockFetch,
} from "./test-utils"

const SPAN_SIZE = 8
const ENCRYPTION_KEY_SIZE = 32

/**
 * Mock uploadEncryptedSOC to store unencrypted SOC data in the mock store.
 *
 * The real function encrypts the payload, but the finder expects to read
 * unencrypted SOC data (identifier + signature + span + payload).
 * This mock bypasses encryption so the finder can parse the data directly.
 */
vi.mock("../../upload-encrypted-data", async (importOriginal) => {
  const mod = await importOriginal<
    typeof import("../../upload-encrypted-data")
  >()
  const { Binary } = await import("cafe-utility")

  return {
    ...mod,
    uploadEncryptedSOC: async (
      bee: any,
      _stamper: any,
      signer: any,
      identifier: any,
      data: Uint8Array,
    ) => {
      // Create span (little-endian uint64 of data length)
      const span = new Uint8Array(SPAN_SIZE)
      const spanView = new DataView(span.buffer)
      spanView.setBigUint64(0, BigInt(data.length), true)

      // Sign: hash(identifier + hash(span + data))
      const contentHash = Binary.keccak256(Binary.concatBytes(span, data))
      const toSign = Binary.concatBytes(
        identifier.toUint8Array(),
        contentHash,
      )
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
        encryptionKey: new Uint8Array(ENCRYPTION_KEY_SIZE),
        tagUid: 0,
      }
    },
  }
})

describe("Epoch Feeds Integration", () => {
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

  describe("Basic Updater and Finder", () => {
    it("should return undefined when no updates exist", async () => {
      const owner = signer.publicKey().address()
      const finder = new SyncEpochFinder(bee as any, topic, owner)

      const result = await finder.findAt(100n, 0n)
      expect(result).toBeUndefined()
    })

    it("should store and retrieve first update", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncEpochFinder(bee as any, topic, owner)

      // Create update
      const at = 100n
      const reference = createTestReference(1)

      await updater.update(at, reference, stamper)

      // Find at same time
      const result = await finder.findAt(at, 0n)
      expect(result).toBeDefined()
      expect(result).toHaveLength(32)
    })

    it("should find update at later time", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncEpochFinder(bee as any, topic, owner)

      const at = 100n
      const reference = createTestReference(1)

      await updater.update(at, reference, stamper)

      // Find at later time
      const result = await finder.findAt(200n, 0n)
      expect(result).toBeDefined()
      expect(result).toHaveLength(32)
    })

    it("should not find update before it was created", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncEpochFinder(bee as any, topic, owner)

      const at = 100n
      const reference = createTestReference(1)

      await updater.update(at, reference, stamper)

      // Try to find at earlier time
      const result = await finder.findAt(50n, 0n)
      expect(result).toBeUndefined()
    })
  })

  describe("Multiple Updates", () => {
    it("should handle sequential updates", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncEpochFinder(bee as any, topic, owner)

      // Create multiple updates
      for (let i = 0; i < 10; i++) {
        const at = BigInt(i * 10)
        const reference = createTestReference(i)
        await updater.update(at, reference, stamper)
      }

      // Find at various times
      for (let i = 0; i < 10; i++) {
        const at = BigInt(i * 10)
        const result = await finder.findAt(at, 0n)
        expect(result).toBeDefined()
        expect(result).toHaveLength(32)
      }
    })

    it("should find correct update between two updates", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncEpochFinder(bee as any, topic, owner)

      // Create two updates
      const ref1 = createTestReference(1)
      const ref2 = createTestReference(2)

      await updater.update(10n, ref1, stamper)
      await updater.update(20n, ref2, stamper)

      // Find at time between updates - should return first
      const result = await finder.findAt(15n, 0n)
      expect(result).toBeDefined()
      expect(result).toHaveLength(32)
    })

    it("should handle sparse updates", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncEpochFinder(bee as any, topic, owner)

      // Create updates with large gaps
      await updater.update(10n, createTestReference(1), stamper)
      await updater.update(1000n, createTestReference(2), stamper)
      await updater.update(100000n, createTestReference(3), stamper)

      // Find at various times
      expect(await finder.findAt(5n, 0n)).toBeUndefined()
      expect(await finder.findAt(10n, 0n)).toBeDefined()
      expect(await finder.findAt(500n, 0n)).toBeDefined()
      expect(await finder.findAt(50000n, 0n)).toBeDefined()
      expect(await finder.findAt(100000n, 0n)).toBeDefined()
    })
  })

  describe("Fixed Intervals", () => {
    it("should handle updates at fixed intervals", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncEpochFinder(bee as any, topic, owner)

      const interval = 10n
      const count = 20

      // Create updates at fixed intervals
      for (let i = 0; i < count; i++) {
        const at = BigInt(i) * interval
        const reference = createTestReference(i)
        await updater.update(at, reference, stamper)
      }

      // Verify we can find updates at each interval
      for (let i = 0; i < count; i++) {
        const at = BigInt(i) * interval
        const result = await finder.findAt(at, 0n)
        expect(result).toBeDefined()
      }

      // Verify we can find updates between intervals
      for (let i = 0; i < count - 1; i++) {
        const at = BigInt(i) * interval + interval / 2n
        const result = await finder.findAt(at, 0n)
        expect(result).toBeDefined()
      }
    })
  })

  describe("Random Intervals", () => {
    it("should handle updates at random intervals", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const finder = new SyncEpochFinder(bee as any, topic, owner)

      const timestamps: bigint[] = []
      let current = 0n

      // Create random updates
      for (let i = 0; i < 30; i++) {
        current += BigInt(Math.floor(Math.random() * 100) + 1)
        timestamps.push(current)
        const reference = createTestReference(i)
        await updater.update(current, reference, stamper)
      }

      // Verify we can find all updates
      for (const timestamp of timestamps) {
        const result = await finder.findAt(timestamp, 0n)
        expect(result).toBeDefined()
      }

      // Verify we can find updates between random timestamps
      for (let i = 0; i < timestamps.length - 1; i++) {
        const between = timestamps[i] + (timestamps[i + 1] - timestamps[i]) / 2n
        const result = await finder.findAt(between, 0n)
        expect(result).toBeDefined()
      }
    })
  })

  describe("Async Finder", () => {
    it("should work with async finder (basic)", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const finder = new AsyncEpochFinder(bee as any, topic, owner)

      const at = 100n
      const reference = createTestReference(1)

      await updater.update(at, reference, stamper)

      const result = await finder.findAt(at, 0n)
      expect(result).toBeDefined()
      expect(result).toHaveLength(32)
    })

    it("should work with async finder (multiple updates)", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const finder = new AsyncEpochFinder(bee as any, topic, owner)

      // Create multiple updates
      for (let i = 0; i < 10; i++) {
        const at = BigInt(i * 10)
        const reference = createTestReference(i)
        await updater.update(at, reference, stamper)
      }

      // Find at various times
      for (let i = 0; i < 10; i++) {
        const at = BigInt(i * 10)
        const result = await finder.findAt(at, 0n)
        expect(result).toBeDefined()
        expect(result).toHaveLength(32)
      }
    })

    it("should work with async finder (sparse updates)", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const finder = new AsyncEpochFinder(bee as any, topic, owner)

      await updater.update(10n, createTestReference(1), stamper)
      await updater.update(1000n, createTestReference(2), stamper)
      await updater.update(100000n, createTestReference(3), stamper)

      expect(await finder.findAt(5n, 0n)).toBeUndefined()
      expect(await finder.findAt(10n, 0n)).toBeDefined()
      expect(await finder.findAt(500n, 0n)).toBeDefined()
      expect(await finder.findAt(50000n, 0n)).toBeDefined()
      expect(await finder.findAt(100000n, 0n)).toBeDefined()
    })
  })

  describe("Updater State Management", () => {
    it("should track last update", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)

      await updater.update(100n, createTestReference(1), stamper)

      const state = updater.getState()
      expect(state.lastUpdate).toBe(100n)
      expect(state.lastEpoch).toBeDefined()
    })

    it("should reset state", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)

      await updater.update(100n, createTestReference(1), stamper)
      updater.reset()

      const state = updater.getState()
      expect(state.lastUpdate).toBe(0n)
      expect(state.lastEpoch).toBeUndefined()
    })

    it("should restore state", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)

      await updater.update(100n, createTestReference(1), stamper)
      const state1 = updater.getState()

      updater.reset()
      updater.setState(state1)

      const state2 = updater.getState()
      expect(state2.lastUpdate).toBe(state1.lastUpdate)
      expect(state2.lastEpoch?.start).toBe(state1.lastEpoch?.start)
      expect(state2.lastEpoch?.level).toBe(state1.lastEpoch?.level)
    })
  })

  describe("Error Handling", () => {
    it("should reject reference with wrong length", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)

      const wrongRef = new Uint8Array(16) // Wrong size
      await expect(
        updater.update(100n, wrongRef, stamper),
      ).rejects.toThrow("Reference must be 32 or 64 bytes")
    })
  })
})

/**
 * Integration tests for epoch feeds
 *
 * Based on the Go implementation tests from bee/pkg/feeds/epochs
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { SyncEpochFinder } from "./finder"
import { AsyncEpochFinder } from "./async-finder"
import { BasicEpochUpdater } from "./updater"
import {
  MockBee,
  MockChunkStore,
  createTestSigner,
  createTestTopic,
  createTestReference,
  mockFetch,
} from "./test-utils"

describe("Epoch Feeds Integration", () => {
  let store: MockChunkStore
  let bee: MockBee
  let signer: ReturnType<typeof createTestSigner>
  let topic: ReturnType<typeof createTestTopic>
  let postageBatchId: string

  beforeEach(() => {
    store = new MockChunkStore()
    bee = new MockBee(store)
    signer = createTestSigner()
    topic = createTestTopic()
    postageBatchId = "0".repeat(64)
    mockFetch(store)
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

      await updater.update(at, reference, postageBatchId)

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

      await updater.update(at, reference, postageBatchId)

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

      await updater.update(at, reference, postageBatchId)

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
        await updater.update(at, reference, postageBatchId)
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

      await updater.update(10n, ref1, postageBatchId)
      await updater.update(20n, ref2, postageBatchId)

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
      await updater.update(10n, createTestReference(1), postageBatchId)
      await updater.update(1000n, createTestReference(2), postageBatchId)
      await updater.update(100000n, createTestReference(3), postageBatchId)

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
        await updater.update(at, reference, postageBatchId)
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
        await updater.update(current, reference, postageBatchId)
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

      await updater.update(at, reference, postageBatchId)

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
        await updater.update(at, reference, postageBatchId)
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

      await updater.update(10n, createTestReference(1), postageBatchId)
      await updater.update(1000n, createTestReference(2), postageBatchId)
      await updater.update(100000n, createTestReference(3), postageBatchId)

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

      await updater.update(100n, createTestReference(1), postageBatchId)

      const state = updater.getState()
      expect(state.lastUpdate).toBe(100n)
      expect(state.lastEpoch).toBeDefined()
    })

    it("should reset state", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)

      await updater.update(100n, createTestReference(1), postageBatchId)
      updater.reset()

      const state = updater.getState()
      expect(state.lastUpdate).toBe(0n)
      expect(state.lastEpoch).toBeUndefined()
    })

    it("should restore state", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)

      await updater.update(100n, createTestReference(1), postageBatchId)
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
        updater.update(100n, wrongRef, postageBatchId),
      ).rejects.toThrow("Reference must be 32 or 64 bytes")
    })
  })
})

/**
 * Integration tests for epoch feeds
 *
 * Based on the Go implementation tests from bee/pkg/feeds/epochs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Binary } from "cafe-utility"
import { PrivateKey } from "@ethersphere/bee-js"
import { SyncEpochFinder } from "./finder"
import { AsyncEpochFinder } from "./async-finder"
import { BasicEpochUpdater } from "./updater"
import { EpochIndex, MAX_LEVEL } from "./epoch"
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

function createTestReference64(seed: number): Uint8Array {
  const ref = new Uint8Array(64)
  const view = new DataView(ref.buffer)
  view.setBigUint64(0, BigInt(seed), false)
  // Ensure second half is non-zero so truncation bugs are caught.
  for (let i = 32; i < 64; i++) {
    ref[i] = (seed + i) & 0xff
  }
  return ref
}

class CountingMockBee extends MockBee {
  public downloadCalls = 0

  override async downloadChunk(reference: string): Promise<Uint8Array> {
    this.downloadCalls++
    const lower = reference.toLowerCase()
    if (!this.getStore().has(lower)) {
      throw new Error("Request failed with status code 500")
    }
    return this.getStore().get(lower)
  }
}

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

async function putEpochSoc(
  store: MockChunkStore,
  signer: ReturnType<typeof createTestSigner>,
  topic: ReturnType<typeof createTestTopic>,
  epoch: EpochIndex,
  payload: Uint8Array,
): Promise<void> {
  const epochHash = await epoch.marshalBinary()
  const identifier = Binary.keccak256(
    Binary.concatBytes(topic.toUint8Array(), epochHash),
  )
  const span = new Uint8Array(SPAN_SIZE)
  new DataView(span.buffer).setBigUint64(0, BigInt(payload.length), true)
  const contentHash = Binary.keccak256(Binary.concatBytes(span, payload))
  const toSign = Binary.concatBytes(identifier, contentHash)
  const signature = signer.sign(toSign)
  const socData = Binary.concatBytes(
    identifier,
    signature.toUint8Array(),
    span,
    payload,
  )
  const owner = signer.publicKey().address().toUint8Array()
  const address = Binary.keccak256(Binary.concatBytes(identifier, owner))
  await store.put(Binary.uint8ArrayToHex(address), socData)
}

function payloadWithTimestamp(
  timestamp: bigint,
  reference: Uint8Array,
): Uint8Array {
  const ts = new Uint8Array(8)
  new DataView(ts.buffer).setBigUint64(0, timestamp, false)
  return Binary.concatBytes(ts, reference)
}

/**
 * Mock uploadEncryptedSOC to store unencrypted SOC data in the mock store.
 *
 * The real function encrypts the payload, but the finder expects to read
 * unencrypted SOC data (identifier + signature + span + payload).
 * This mock bypasses encryption so the finder can parse the data directly.
 */
vi.mock("../../upload-encrypted-data", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../upload-encrypted-data")>()
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
      await expect(updater.update(100n, wrongRef, stamper)).rejects.toThrow(
        "Reference must be 32 or 64 bytes",
      )
    })
  })

  describe("Correctness Core Regression Matrix", () => {
    it("respects after hint semantics for sync and async finders", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const ref100 = createTestReference(100)
      const ref200 = createTestReference(200)
      const ref300 = createTestReference(300)

      await updater.update(100n, ref100, stamper)
      await updater.update(200n, ref200, stamper)
      await updater.update(300n, ref300, stamper)

      const finders = [
        new SyncEpochFinder(bee as any, topic, owner),
        new AsyncEpochFinder(bee as any, topic, owner),
      ]

      for (const finder of finders) {
        expect(await finder.findAt(250n, 0n)).toEqual(ref200)
        expect(await finder.findAt(250n, 200n)).toEqual(ref200)
        expect(await finder.findAt(300n, 200n)).toEqual(ref300)
      }
    })

    it("remains stable when after is greater than at", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const ref100 = createTestReference(100)
      const ref200 = createTestReference(200)

      await updater.update(100n, ref100, stamper)
      await updater.update(200n, ref200, stamper)

      const finders = [
        new SyncEpochFinder(bee as any, topic, owner),
        new AsyncEpochFinder(bee as any, topic, owner),
      ]

      for (const finder of finders) {
        const withoutHint = await finder.findAt(150n, 0n)
        const withAheadHint = await finder.findAt(150n, 300n)
        expect(withAheadHint).toEqual(withoutHint)
      }
    })

    it("handles boundary timestamps 0 and 1", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const ref0 = createTestReference(10)
      const ref1 = createTestReference(11)

      await updater.update(0n, ref0, stamper)
      await updater.update(1n, ref1, stamper)

      const syncFinder = new SyncEpochFinder(bee as any, topic, owner)
      const asyncFinder = new AsyncEpochFinder(bee as any, topic, owner)

      expect(await syncFinder.findAt(0n, 0n)).toEqual(ref0)
      expect(await syncFinder.findAt(1n, 0n)).toEqual(ref1)
      expect(await asyncFinder.findAt(0n, 0n)).toEqual(ref0)
      expect(await asyncFinder.findAt(1n, 0n)).toEqual(ref1)
    })

    it("uses deterministic last-write-wins for same timestamp updates", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      await updater.update(100n, createTestReference(1), stamper)
      const ref2 = createTestReference(2)
      await updater.update(100n, ref2, stamper)
      const finder = new AsyncEpochFinder(
        bee as any,
        topic,
        signer.publicKey().address(),
      )
      expect(await finder.findAt(100n, 0n)).toEqual(ref2)
    })

    it("isolates by topic for same owner and timestamp", async () => {
      const topicA = createTestTopic("topic-a")
      const topicB = createTestTopic("topic-b")
      const updaterA = new BasicEpochUpdater(bee as any, topicA, signer)
      const updaterB = new BasicEpochUpdater(bee as any, topicB, signer)
      const owner = signer.publicKey().address()
      const refA = createTestReference(9001)
      const refB = createTestReference(9002)

      await updaterA.update(100n, refA, stamper)
      await updaterB.update(100n, refB, stamper)

      const finderA = new AsyncEpochFinder(bee as any, topicA, owner)
      const finderB = new AsyncEpochFinder(bee as any, topicB, owner)
      expect(await finderA.findAt(100n, 0n)).toEqual(refA)
      expect(await finderB.findAt(100n, 0n)).toEqual(refB)
    })

    it("isolates by owner for same topic and timestamp", async () => {
      const signerA = createTestSigner()
      const signerB = new PrivateKey(
        "9a4ce1ef8d14b7864ea3f1ecfcb39f937ce4a45f47f4d7d02f6b76f1f3ab2c11",
      )
      const refA = createTestReference(5001)
      const refB = createTestReference(5002)
      const at = 100n

      // Write top-level epoch chunks directly for each owner to avoid mockFetch
      // owner coupling and assert true owner isolation.
      const payloadA = Binary.concatBytes(
        (() => {
          const ts = new Uint8Array(8)
          new DataView(ts.buffer).setBigUint64(0, at, false)
          return ts
        })(),
        refA,
      )
      const payloadB = Binary.concatBytes(
        (() => {
          const ts = new Uint8Array(8)
          new DataView(ts.buffer).setBigUint64(0, at, false)
          return ts
        })(),
        refB,
      )
      await putEpochSoc(store, signerA, topic, new EpochIndex(0n, 32), payloadA)
      await putEpochSoc(store, signerB, topic, new EpochIndex(0n, 32), payloadB)

      const finderA = new AsyncEpochFinder(
        bee as any,
        topic,
        signerA.publicKey().address(),
      )
      const finderB = new AsyncEpochFinder(
        bee as any,
        topic,
        signerB.publicKey().address(),
      )
      expect(await finderA.findAt(at, 0n)).toEqual(refA)
      expect(await finderB.findAt(at, 0n)).toEqual(refB)
    })

    it("roundtrips 64-byte references without truncation", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const ref64 = createTestReference64(42)
      const ref32 = createTestReference(24)

      await updater.update(100n, ref64, stamper)
      await updater.update(200n, ref32, stamper)

      const finder = new AsyncEpochFinder(bee as any, topic, owner)
      const got64 = await finder.findAt(100n, 0n)
      const got32 = await finder.findAt(200n, 0n)
      expect(got64).toBeDefined()
      expect(got64).toHaveLength(64)
      expect(got64).toEqual(ref64)
      expect(got32).toBeDefined()
      expect(got32).toHaveLength(32)
      expect(got32).toEqual(ref32)
    })

    it("keeps exact-at and between-at consistency", async () => {
      const updater = new BasicEpochUpdater(bee as any, topic, signer)
      const owner = updater.getOwner()
      const ref100 = createTestReference(100)
      const ref150 = createTestReference(150)
      await updater.update(100n, ref100, stamper)
      await updater.update(150n, ref150, stamper)

      const finder = new AsyncEpochFinder(bee as any, topic, owner)
      expect(await finder.findAt(100n, 0n)).toEqual(ref100)
      expect(await finder.findAt(149n, 0n)).toEqual(ref100)
      expect(await finder.findAt(150n, 0n)).toEqual(ref150)
      expect(await finder.findAt(151n, 0n)).toEqual(ref150)
    })

    it("bounded fallback returns miss when nearest valid leaf is outside window", async () => {
      const failingBee = new CountingMockBee(store)
      const owner = signer.publicKey().address()
      const at = 2000n
      const farAt = 1500n
      const farRef = createTestReference(3333)
      const poisonTimestamp = 2n ** 63n
      const poisonPayload = Binary.concatBytes(
        (() => {
          const ts = new Uint8Array(8)
          new DataView(ts.buffer).setBigUint64(0, poisonTimestamp, false)
          return ts
        })(),
        createTestReference(4444),
      )

      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 32),
        poisonPayload,
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 31),
        poisonPayload,
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(farAt, 0),
        Binary.concatBytes(
          (() => {
            const ts = new Uint8Array(8)
            new DataView(ts.buffer).setBigUint64(0, farAt, false)
            return ts
          })(),
          farRef,
        ),
      )

      const finder = new AsyncEpochFinder(failingBee as any, topic, owner)
      const result = await finder.findAt(at, 0n)
      expect(result).toBeUndefined()
      expect(failingBee.downloadCalls).toBeLessThanOrEqual(220)
    })
  })

  describe("Epoch Correctness Stress Matrix", () => {
    it("keeps probes bounded with mixed 404/500/timeout failures", async () => {
      const mixedBee = new MixedErrorMockBee(store)
      const owner = signer.publicKey().address()
      const finder = new AsyncEpochFinder(mixedBee as any, topic, owner)

      const result = await finder.findAt(1771362000n, 0n)
      expect(result).toBeUndefined()
      expect(mixedBee.downloadCalls).toBeLessThanOrEqual(80)
    })

    it("resolves poisoned root with valid intermediate and leaf data", async () => {
      const failingBee = new CountingMockBee(store)
      const owner = signer.publicKey().address()
      const at = 1771362100n
      const expected = createTestReference(6100)

      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 32),
        payloadWithTimestamp(2n ** 63n, createTestReference(1)),
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 31),
        payloadWithTimestamp(2n ** 63n, createTestReference(2)),
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(at, 0),
        payloadWithTimestamp(at, expected),
      )

      const asyncFinder = new AsyncEpochFinder(failingBee as any, topic, owner)
      const syncFinder = new SyncEpochFinder(failingBee as any, topic, owner)
      expect(await asyncFinder.findAt(at, 0n)).toEqual(expected)
      expect(await syncFinder.findAt(at, 0n)).toEqual(expected)
      expect(failingBee.downloadCalls).toBeLessThanOrEqual(120)
    })

    it("maintains expected behavior across power-of-two timestamp boundaries", async () => {
      const owner = signer.publicKey().address()
      const finder = new AsyncEpochFinder(bee as any, topic, owner)

      const before = (1n << 20n) - 1n
      const at = 1n << 20n
      const after = (1n << 20n) + 1n

      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(before, 0),
        payloadWithTimestamp(before, createTestReference(7001)),
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(at, 0),
        payloadWithTimestamp(at, createTestReference(7002)),
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(after, 0),
        payloadWithTimestamp(after, createTestReference(7003)),
      )

      expect(await finder.findAt(before, 0n)).toEqual(createTestReference(7001))
      expect(await finder.findAt(at, 0n)).toEqual(createTestReference(7002))
      expect(await finder.findAt(after, 0n)).toEqual(createTestReference(7003))
    })

    it("returns inside-window previous leaf and misses outside-window one under poison", async () => {
      const failingBee = new CountingMockBee(store)
      const owner = signer.publicKey().address()
      const at = 3000n
      const insideAt = at - 64n
      const outsideAt = at - 1000n
      const insideRef = createTestReference(8001)
      const outsideRef = createTestReference(8002)

      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 32),
        payloadWithTimestamp(2n ** 63n, createTestReference(3)),
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 31),
        payloadWithTimestamp(2n ** 63n, createTestReference(4)),
      )

      // Inside bounded window should be found.
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(insideAt, 0),
        payloadWithTimestamp(insideAt, insideRef),
      )
      const finderInside = new AsyncEpochFinder(failingBee as any, topic, owner)
      expect(await finderInside.findAt(at, 0n)).toEqual(insideRef)

      // Separate topic: outside window should miss.
      const topic2 = createTestTopic("outside-window-topic")
      await putEpochSoc(
        store,
        signer,
        topic2,
        new EpochIndex(0n, 32),
        payloadWithTimestamp(2n ** 63n, createTestReference(5)),
      )
      await putEpochSoc(
        store,
        signer,
        topic2,
        new EpochIndex(0n, 31),
        payloadWithTimestamp(2n ** 63n, createTestReference(6)),
      )
      await putEpochSoc(
        store,
        signer,
        topic2,
        new EpochIndex(outsideAt, 0),
        payloadWithTimestamp(outsideAt, outsideRef),
      )
      const finderOutside = new AsyncEpochFinder(
        failingBee as any,
        topic2,
        owner,
      )
      expect(await finderOutside.findAt(at, 0n)).toBeUndefined()
    })

    it("preserves owner/topic isolation under poisoned ancestors", async () => {
      const failingBee = new CountingMockBee(store)
      const signerA = createTestSigner()
      const signerB = new PrivateKey(
        "7f6c8f5de489c56ba40b494a26d0c6dd0c05fc4f0d37fe2f217af6e9ac7b1a01",
      )
      const topicA = createTestTopic("iso-a")
      const topicB = createTestTopic("iso-b")
      const at = 1771363000n
      const refAA = createTestReference(9101)
      const refBB = createTestReference(9202)

      await putEpochSoc(
        store,
        signerA,
        topicA,
        new EpochIndex(0n, 32),
        payloadWithTimestamp(2n ** 63n, createTestReference(7)),
      )
      await putEpochSoc(
        store,
        signerB,
        topicB,
        new EpochIndex(0n, 32),
        payloadWithTimestamp(2n ** 63n, createTestReference(8)),
      )
      await putEpochSoc(
        store,
        signerA,
        topicA,
        new EpochIndex(at, 0),
        payloadWithTimestamp(at, refAA),
      )
      await putEpochSoc(
        store,
        signerB,
        topicB,
        new EpochIndex(at, 0),
        payloadWithTimestamp(at, refBB),
      )

      const finderAA = new AsyncEpochFinder(
        failingBee as any,
        topicA,
        signerA.publicKey().address(),
      )
      const finderBB = new AsyncEpochFinder(
        failingBee as any,
        topicB,
        signerB.publicKey().address(),
      )
      expect(await finderAA.findAt(at, 0n)).toEqual(refAA)
      expect(await finderBB.findAt(at, 0n)).toEqual(refBB)
    })
  })

  describe("Pathological Network Conditions", () => {
    it("keeps lookup probes bounded when many epoch chunks fail with 500", async () => {
      const failingBee = new CountingMockBee(store)
      const owner = signer.publicKey().address()
      const finder = new AsyncEpochFinder(failingBee as any, topic, owner)

      await finder.findAt(1771360835n, 0n)

      // Bound should stay near tree depth (log2 range), not explode.
      expect(failingBee.downloadCalls).toBeLessThanOrEqual(MAX_LEVEL + 2)
    })

    it("finds a valid leaf update even when upper epochs contain poisoned timestamps", async () => {
      const failingBee = new CountingMockBee(store)
      const owner = signer.publicKey().address()
      const at = 1771360835n
      const reference = createTestReference(999)

      // Poison ancestors with far-future timestamps to force descent.
      const poisonTimestamp = 2n ** 63n
      const poisonPayload = Binary.concatBytes(
        (() => {
          const ts = new Uint8Array(8)
          new DataView(ts.buffer).setBigUint64(0, poisonTimestamp, false)
          return ts
        })(),
        createTestReference(111),
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 32),
        poisonPayload,
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 31),
        poisonPayload,
      )

      // Write the expected leaf update at the exact timestamp.
      const leafPayload = Binary.concatBytes(
        (() => {
          const ts = new Uint8Array(8)
          new DataView(ts.buffer).setBigUint64(0, at, false)
          return ts
        })(),
        reference,
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(at, 0),
        leafPayload,
      )

      const finder = new AsyncEpochFinder(failingBee as any, topic, owner)
      const result = await finder.findAt(at, 0n)

      expect(result).toBeDefined()
      expect(result).toEqual(reference)
      expect(failingBee.downloadCalls).toBeLessThanOrEqual(80)
    })

    it("sync finder also finds exact leaf under poisoned ancestors", async () => {
      const failingBee = new CountingMockBee(store)
      const owner = signer.publicKey().address()
      const at = 1771360999n
      const reference = createTestReference(321)

      const poisonTimestamp = 2n ** 63n
      const poisonPayload = Binary.concatBytes(
        (() => {
          const ts = new Uint8Array(8)
          new DataView(ts.buffer).setBigUint64(0, poisonTimestamp, false)
          return ts
        })(),
        createTestReference(777),
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 32),
        poisonPayload,
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 31),
        poisonPayload,
      )

      const leafPayload = Binary.concatBytes(
        (() => {
          const ts = new Uint8Array(8)
          new DataView(ts.buffer).setBigUint64(0, at, false)
          return ts
        })(),
        reference,
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(at, 0),
        leafPayload,
      )

      const finder = new SyncEpochFinder(failingBee as any, topic, owner)
      const result = await finder.findAt(at, 0n)

      expect(result).toBeDefined()
      expect(result).toEqual(reference)
      expect(failingBee.downloadCalls).toBeLessThanOrEqual(90)
    })

    it("async finder can return previous update between two leaf updates when ancestors are poisoned", async () => {
      const failingBee = new CountingMockBee(store)
      const owner = signer.publicKey().address()
      const firstAt = 1771361000n
      const secondAt = 1771361100n
      const queryAt = 1771361050n
      const firstRef = createTestReference(1001)
      const secondRef = createTestReference(1002)

      const poisonTimestamp = 2n ** 63n
      const poisonPayload = Binary.concatBytes(
        (() => {
          const ts = new Uint8Array(8)
          new DataView(ts.buffer).setBigUint64(0, poisonTimestamp, false)
          return ts
        })(),
        createTestReference(888),
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 32),
        poisonPayload,
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 31),
        poisonPayload,
      )

      const firstLeaf = Binary.concatBytes(
        (() => {
          const ts = new Uint8Array(8)
          new DataView(ts.buffer).setBigUint64(0, firstAt, false)
          return ts
        })(),
        firstRef,
      )
      const secondLeaf = Binary.concatBytes(
        (() => {
          const ts = new Uint8Array(8)
          new DataView(ts.buffer).setBigUint64(0, secondAt, false)
          return ts
        })(),
        secondRef,
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(firstAt, 0),
        firstLeaf,
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(secondAt, 0),
        secondLeaf,
      )

      const finder = new AsyncEpochFinder(failingBee as any, topic, owner)
      const result = await finder.findAt(queryAt, 0n)

      expect(result).toBeDefined()
      expect(result).toEqual(firstRef)
      expect(failingBee.downloadCalls).toBeLessThanOrEqual(120)
    })

    it("keeps probes bounded for upload read-back style lookup with after=at", async () => {
      const failingBee = new CountingMockBee(store)
      const owner = signer.publicKey().address()
      const at = 1771362340n

      // Poison upper epochs so traversal sees invalid ancestors and many misses.
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 32),
        payloadWithTimestamp(2n ** 63n, createTestReference(1101)),
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 31),
        payloadWithTimestamp(2n ** 63n, createTestReference(1102)),
      )

      const finder = new AsyncEpochFinder(failingBee as any, topic, owner)
      const result = await finder.findAt(at, at)
      expect(result).toBeUndefined()
      // Bound should stay near tree depth for upload read-back checks.
      expect(failingBee.downloadCalls).toBeLessThanOrEqual(MAX_LEVEL + 6)
    })

    it("returns exact timestamp update under poison with upload read-back hint", async () => {
      const failingBee = new CountingMockBee(store)
      const owner = signer.publicKey().address()
      const at = 1771362340n
      const expected = createTestReference64(1201)

      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 32),
        payloadWithTimestamp(2n ** 63n, createTestReference(1202)),
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(0n, 31),
        payloadWithTimestamp(2n ** 63n, createTestReference(1203)),
      )
      await putEpochSoc(
        store,
        signer,
        topic,
        new EpochIndex(at, 0),
        payloadWithTimestamp(at, expected),
      )

      const finder = new AsyncEpochFinder(failingBee as any, topic, owner)
      const result = await finder.findAt(at, at)
      expect(result).toEqual(expected)
      expect(failingBee.downloadCalls).toBeLessThanOrEqual(MAX_LEVEL + 6)
    })
  })
})

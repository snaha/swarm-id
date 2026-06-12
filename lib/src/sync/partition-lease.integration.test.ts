// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-module integration tests for the consolidated `PartitionLease`.
 * In-memory only — no live Bee node / network.
 *
 * Uses MockBee + mockFetch so that `acquirePartitionLock`,
 * `readPartitionLock`, `writePartitionLock`, `readPartitionState`, and
 * `writePartitionState` run against an in-memory chunk store. The lock SOC
 * is the single source of truth; the class scans it on every acquire (no
 * local-state shortcut).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  BatchId,
  PrivateKey,
  type Bee,
  type Stamper,
} from "@ethersphere/bee-js"
import { PartitionLease } from "./partition-lease"
import {
  makeDeviceTiebreaker,
  NO_HOLDER_DEVICE_ID,
  readPartitionLock,
  writePartitionLock,
} from "./partition-lock"
import { Binary } from "cafe-utility"
import {
  LEASE_TTL_MS,
  PARTITION_COUNT,
  NUM_BUCKETS,
  getChunkLayout,
  toBucket,
} from "../utils/batch-utilization"
import { makeEncryptedContentAddressedChunk } from "../chunk"
import { uploadData, type UploadTarget } from "../proxy/upload"
import {
  MockBee,
  MockChunkStore,
  createTestSigner,
  createMockStamper,
  mockFetch,
} from "../proxy/feeds/epochs/test-utils"

// ============================================================================
// Fixtures
// ============================================================================

const TEST_BATCH_ID = new BatchId("ab".repeat(32))
const TEST_BATCH_DEPTH = 24
const TEST_ENC_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)
const DEVICE_A = "device-alpha-111"
const DEVICE_B = "device-beta-222"

const BACKUP_SIGNER = createTestSigner() as PrivateKey
const OWNER = BACKUP_SIGNER.publicKey().address()

const GUARD_MS = 50 // small for tests; production default is 2000

// ============================================================================
// Helpers
// ============================================================================

/**
 * Upload `plaintext` with a random encryption key (mirrors the private
 * `uploadReservedChunk` in partition-state.ts) and return its 64-byte
 * encrypted reference (address ‖ key).
 */
async function uploadEncryptedBlob(
  target: UploadTarget,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const encrypted = makeEncryptedContentAddressedChunk(plaintext)
  await uploadData(target, plaintext, {
    encryptionKey: encrypted.encryptionKey,
    deferred: false,
  })
  return encrypted.reference.toUint8Array()
}

/**
 * Bucket of the partition-state feed's LATEST entry SOC — the bucket
 * `readPartitionState` compensates with +1 (the entry's own SOC consumed an
 * unrecorded data slot there; see partition-state.ts).
 */
async function feedSocBucket(partition: number): Promise<number> {
  const { makePartitionStateTopic } = await import("./partition-state")
  const { AsyncEpochFinder, epochSocAddress } =
    await import("../proxy/feeds/epochs")
  const topic = makePartitionStateTopic(TEST_BATCH_ID, partition)
  const finder = new AsyncEpochFinder(bee as unknown as Bee, topic, OWNER)
  const entry = await finder.findAtWithMetadata(
    BigInt(Math.floor(Date.now() / 1000)),
  )
  const addr = await epochSocAddress(topic, entry!.epoch, OWNER)
  return toBucket(addr)
}

function makeLease(opts: {
  deviceId: string
  bee: Bee
  now?: () => number
}): PartitionLease {
  return new PartitionLease({
    bee: opts.bee,
    deviceId: opts.deviceId,
    batchId: TEST_BATCH_ID,
    batchDepth: TEST_BATCH_DEPTH,
    swarmEncryptionKey: TEST_ENC_KEY,
    backupSigner: BACKUP_SIGNER,
    stamper: createMockStamper() as unknown as Stamper,
    now: opts.now,
    guardMs: GUARD_MS,
  })
}

// ============================================================================
// Setup / Teardown
// ============================================================================

let store: MockChunkStore
let bee: MockBee

beforeEach(() => {
  store = new MockChunkStore()
  bee = new MockBee(store)
  mockFetch(store, OWNER)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ============================================================================
// Tests
// ============================================================================

describe("readPartitionState / writePartitionState round-trip", () => {
  it("reads back the exact published counters", async () => {
    const { writePartitionState, readPartitionState } =
      await import("./partition-state")

    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[100] = 5
    localCounter[200] = 12

    const stamper = createMockStamper() as unknown as Stamper
    await writePartitionState({
      bee: bee as unknown as Bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
    })

    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })

    expect(result.unchanged).toBe(false)
    // The read equals the published snapshot plus exactly one compensation:
    // +1 in the bucket of the feed entry's own SOC, whose data slot the
    // publish-then-update-feed ordering left unrecorded. Resuming there
    // without the +1 would overstamp (and evict) the feed entry itself.
    const expected = localCounter.slice()
    expected[await feedSocBucket(0)] += 1
    expect(result.localCounter).toEqual(expected)
  })

  it("reports the published state-chunk buckets identically on write and read", async () => {
    const { writePartitionState, readPartitionState } =
      await import("./partition-state")
    const { lockSocBucket } = await import("../utils/lock-soc")
    const { getChunkLayout } = await import("../utils/batch-utilization")

    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[42] = 3
    const written = await writePartitionState({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
    })

    // One bucket per counter chunk plus the reference chunk, all distinct,
    // and none on the partition's lock-SOC bucket (an overstamp there would
    // evict the lock itself).
    const { numUtilizationChunks } = getChunkLayout(TEST_BATCH_DEPTH)
    expect(written.stateBuckets).toHaveLength(numUtilizationChunks + 1)
    expect(new Set(written.stateBuckets).size).toBe(numUtilizationChunks + 1)
    expect(written.stateBuckets).not.toContain(lockSocBucket(0, OWNER))

    // A taking-over device derives the same protection set from the
    // reference chunk it downloads.
    const read = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(new Set(read.stateBuckets)).toEqual(new Set(written.stateBuckets))
  })

  it("derives the same feed-entry SOC address the updater actually wrote", async () => {
    const { makePartitionStateTopic } = await import("./partition-state")
    const { BasicEpochUpdater, EpochIndex, epochSocAddress } =
      await import("../proxy/feeds/epochs")

    const topic = makePartitionStateTopic(TEST_BATCH_ID, 0)
    const updater = new BasicEpochUpdater(topic, BACKUP_SIGNER)
    const result = await updater.update(
      BigInt(Math.floor(Date.now() / 1000)),
      new Uint8Array(64).fill(0x11),
      {
        mode: "stamper",
        bee: bee as unknown as Bee,
        stamper: createMockStamper() as unknown as Stamper,
      },
    )

    const derived = await epochSocAddress(
      topic,
      new EpochIndex(result.epoch.start, result.epoch.level),
      OWNER,
    )
    expect(derived).toEqual(result.socAddress)
  })

  it("skips the reference + counter-chunk downloads when the feed reference is unchanged", async () => {
    const { writePartitionState, readPartitionState } =
      await import("./partition-state")

    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[100] = 5
    const stamper = createMockStamper() as unknown as Stamper
    const { referenceHex: writtenRef } = await writePartitionState({
      bee: bee as unknown as Bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
    })

    const getSpy = vi.spyOn(store, "get")

    // No cached reference → full download.
    const full = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(full.unchanged).toBe(false)
    const expected = localCounter.slice()
    expected[await feedSocBucket(0)] += 1
    expect(full.localCounter).toEqual(expected)
    expect(full.referenceHex).toBe(writtenRef)
    const callsForFullRead = getSpy.mock.calls.length

    // Same reference cached → skip, reuse local counter, far fewer chunk reads.
    const cached = await readPartitionState(
      {
        bee: bee as unknown as Bee,
        owner: OWNER,
        batchId: TEST_BATCH_ID,
        partition: 0,
        batchDepth: TEST_BATCH_DEPTH,
      },
      writtenRef,
    )
    expect(cached.unchanged).toBe(true)
    expect(cached.localCounter).toBeUndefined()
    expect(cached.referenceHex).toBe(writtenRef)
    const callsForCachedRead = getSpy.mock.calls.length - callsForFullRead
    expect(callsForCachedRead).toBeLessThan(callsForFullRead)
  })

  it("reports readFailed when the feed entry is unreadable (no zero-seed)", async () => {
    const { readPartitionState, makePartitionStateTopic } =
      await import("./partition-state")
    const { BasicEpochUpdater } = await import("../proxy/feeds/epochs")

    // Point the partition-state feed at a reference that resolves to nothing
    // (e.g. an evicted or corrupt chunk). The feed HAS an entry, so the
    // partition has a real resume point we failed to learn — readPartitionState
    // must NOT fall back to a zero counter (resuming at zero would re-issue
    // every used slot and evict the partition's data); it reports readFailed.
    const topic = makePartitionStateTopic(TEST_BATCH_ID, 0)
    const updater = new BasicEpochUpdater(topic, BACKUP_SIGNER)
    const danglingRef = new Uint8Array(64).fill(0x99)
    await updater.update(BigInt(Math.floor(Date.now() / 1000)), danglingRef, {
      mode: "stamper",
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
    })

    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })

    expect(result.readFailed).toBe(true)
    expect(result.localCounter).toBeUndefined()
    expect(result.referenceHex).toBeUndefined()
  })

  it("reports readFailed when a single counter chunk is missing", async () => {
    const { writePartitionState, readPartitionState } =
      await import("./partition-state")

    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[100] = 5
    await writePartitionState({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
    })

    // Learn a counter-chunk address by spying on a successful read: the read
    // path fetches feed chunks, then the reference chunk, then the counter
    // chunks in order — so the LAST fetched address is a counter chunk.
    const getSpy = vi.spyOn(store, "get")
    const ok = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(ok.readFailed).toBeUndefined()
    const lastFetched = getSpy.mock.calls.at(-1)![0]
    expect(store.delete(lastFetched)).toBe(true)

    // One published chunk evicted/unreadable → the whole read fails safe.
    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(result.readFailed).toBe(true)
    expect(result.localCounter).toBeUndefined()
  })

  it("still zero-seeds when the feed has no entry at all", async () => {
    const { readPartitionState } = await import("./partition-state")

    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })

    expect(result.readFailed).toBeUndefined()
    expect(result.unchanged).toBe(false)
    expect(result.localCounter![0]).toBe(0)
  })
})

describe("PartitionLease.acquire — unreadable partition state", () => {
  it("degrades to read-only without writing the lock SOC", async () => {
    const { makePartitionStateTopic } = await import("./partition-state")
    const { BasicEpochUpdater } = await import("../proxy/feeds/epochs")

    // Partition 0's state feed points at an unreadable reference.
    const topic = makePartitionStateTopic(TEST_BATCH_ID, 0)
    const updater = new BasicEpochUpdater(topic, BACKUP_SIGNER)
    await updater.update(
      BigInt(Math.floor(Date.now() / 1000)),
      new Uint8Array(64).fill(0x99),
      {
        mode: "stamper",
        bee: bee as unknown as Bee,
        stamper: createMockStamper() as unknown as Stamper,
      },
    )

    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    const result = await lease.acquire({ partitionCount: PARTITION_COUNT })

    expect(result.isReadOnly).toBe(true)
    expect(result.partition).toBeUndefined()
    expect(lease.currentPartition).toBeUndefined()

    // Crucially: no claim was written over a partition whose resume point is
    // unknown.
    const lock = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(lock).toBeUndefined()
  })

  it("reports readFailed when the reference chunk has the wrong length", async () => {
    const { readPartitionState, makePartitionStateTopic } =
      await import("./partition-state")
    const { BasicEpochUpdater } = await import("../proxy/feeds/epochs")

    const target: UploadTarget = {
      mode: "stamper",
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
    }

    // A readable chunk that is NOT numUtilizationChunks × 64 bytes — e.g. an
    // entry written by a buggy or older writer. Reads must fail safe: the
    // feed HAS an entry, so the partition has a real resume point — a zero
    // counter would re-issue every used slot.
    const malformedRef = await uploadEncryptedBlob(
      target,
      new Uint8Array(32).fill(7),
    )
    const topic = makePartitionStateTopic(TEST_BATCH_ID, 0)
    const updater = new BasicEpochUpdater(topic, BACKUP_SIGNER)
    await updater.update(
      BigInt(Math.floor(Date.now() / 1000)),
      malformedRef,
      target,
    )

    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })

    expect(result.readFailed).toBe(true)
    expect(result.localCounter).toBeUndefined()
    // The failed read must not be cached as "synced".
    expect(result.referenceHex).toBeUndefined()
  })

  it("reports readFailed when a counter chunk has the wrong length", async () => {
    const { readPartitionState, makePartitionStateTopic } =
      await import("./partition-state")
    const { BasicEpochUpdater } = await import("../proxy/feeds/epochs")

    const target: UploadTarget = {
      mode: "stamper",
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
    }

    // A correctly-sized reference chunk whose entries all point at a counter
    // chunk of the wrong length (100 bytes instead of CHUNK_SIZE). mergeChunk
    // must reject it and the read must fail safe (readFailed, no zero-seed).
    const shortCounterRef = await uploadEncryptedBlob(
      target,
      new Uint8Array(100).fill(1),
    )
    const { numUtilizationChunks } = getChunkLayout(TEST_BATCH_DEPTH)
    const referenceChunk = Binary.concatBytes(
      ...Array.from({ length: numUtilizationChunks }, () => shortCounterRef),
    )
    const referenceChunkRef = await uploadEncryptedBlob(target, referenceChunk)

    const topic = makePartitionStateTopic(TEST_BATCH_ID, 0)
    const updater = new BasicEpochUpdater(topic, BACKUP_SIGNER)
    await updater.update(
      BigInt(Math.floor(Date.now() / 1000)),
      referenceChunkRef,
      target,
    )

    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })

    expect(result.readFailed).toBe(true)
    expect(result.localCounter).toBeUndefined()
    expect(result.referenceHex).toBeUndefined()
  })

  it("rejects publishing a counter with the wrong length", async () => {
    const { writePartitionState } = await import("./partition-state")

    await expect(
      writePartitionState({
        bee: bee as unknown as Bee,
        stamper: createMockStamper() as unknown as Stamper,
        batchId: TEST_BATCH_ID,
        batchDepth: TEST_BATCH_DEPTH,
        partition: 0,
        localCounter: new Uint32Array(5),
        backupSigner: BACKUP_SIGNER,
      }),
    ).rejects.toThrow(/65536/)
  })
})

describe("PartitionLease.acquire — legacy fall-through", () => {
  it("partitionCount=1 returns undefined partition with no Swarm activity", async () => {
    const spy = vi.spyOn(bee, "downloadChunk")
    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    const result = await lease.acquire({ partitionCount: 1 })
    expect(result.partition).toBeUndefined()
    expect(result.isReadOnly).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("PartitionLease.acquire — fresh scan", () => {
  it("picks partition 0 when no lock SOCs exist", async () => {
    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    const result = await lease.acquire({ partitionCount: PARTITION_COUNT })
    expect(result.partition).toBe(0)
    expect(result.isReadOnly).toBe(false)
    expect(lease.currentPartition).toBe(0)

    const observed = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(observed?.holderDeviceId).toBe(DEVICE_A)
  })

  it("skips over a live foreign holder and picks the next partition", async () => {
    const NOW = 5_000_000
    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
      payload: {
        holderDeviceId: DEVICE_B,
        generation: {
          timestampMs: NOW,
          tiebreaker: makeDeviceTiebreaker(DEVICE_B),
        },
        acquiredAt: NOW,
        leasedUntil: NOW + LEASE_TTL_MS,
      },
    })

    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW + 1000,
    })
    const result = await lease.acquire({ partitionCount: PARTITION_COUNT })
    expect(result.partition).toBe(1)
    expect(result.isReadOnly).toBe(false)
  })

  it("takes over an expired foreign holder", async () => {
    const PAST = 1_000_000
    const NOW = PAST + LEASE_TTL_MS + 10_000

    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
      payload: {
        holderDeviceId: DEVICE_B,
        generation: {
          timestampMs: PAST,
          tiebreaker: makeDeviceTiebreaker(DEVICE_B),
        },
        acquiredAt: PAST,
        leasedUntil: PAST + LEASE_TTL_MS, // < NOW → expired
      },
    })

    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
    })
    const result = await lease.acquire({ partitionCount: PARTITION_COUNT })
    expect(result.partition).toBe(0)

    const observed = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(observed?.holderDeviceId).toBe(DEVICE_A)
  })

  it("returns read-only when every partition has a live foreign holder", async () => {
    const NOW = 5_000_000
    const stamper = createMockStamper() as unknown as Stamper
    for (let p = 0; p < PARTITION_COUNT; p++) {
      await writePartitionLock({
        bee: bee as unknown as Bee,
        stamper,
        backupSigner: BACKUP_SIGNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        partition: p,
        payload: {
          holderDeviceId: DEVICE_B,
          generation: {
            timestampMs: NOW,
            tiebreaker: makeDeviceTiebreaker(DEVICE_B),
          },
          acquiredAt: NOW,
          leasedUntil: NOW + LEASE_TTL_MS,
        },
      })
    }

    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW + 1000,
    })
    const result = await lease.acquire({ partitionCount: PARTITION_COUNT })
    expect(result.partition).toBeUndefined()
    expect(result.isReadOnly).toBe(true)
  })

  it("refreshes the same partition it already holds (re-acquire)", async () => {
    const NOW1 = 1_000_000
    const NOW2 = NOW1 + 5_000

    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW1,
    })
    const r1 = await lease.acquire({ partitionCount: PARTITION_COUNT })
    expect(r1.partition).toBe(0)

    // A second acquire on the same instance re-reads the lock SOC, sees
    // itself as the holder, and refreshes the same partition.
    const lease2 = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW2,
    })
    const r2 = await lease2.acquire({ partitionCount: PARTITION_COUNT })
    expect(r2.partition).toBe(0)
    expect(r2.lockPayload?.leasedUntil).toBe(NOW2 + LEASE_TTL_MS)
  })
})

describe("PartitionLease.acquire — two devices, disjoint partitions", () => {
  it("DEVICE_A on p=0, DEVICE_B picks p=1 by reading A's lock SOC", async () => {
    const NOW = 5_000_000

    const leaseA = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
    })
    const rA = await leaseA.acquire({ partitionCount: PARTITION_COUNT })
    expect(rA.partition).toBe(0)

    const leaseB = makeLease({
      deviceId: DEVICE_B,
      bee: bee as unknown as Bee,
      now: () => NOW + 1000,
    })
    const rB = await leaseB.acquire({ partitionCount: PARTITION_COUNT })
    expect(rB.partition).toBe(1)
    expect(rA.partition).not.toBe(rB.partition)
  })
})

describe("PartitionLease.acquire — turn-taking (3rd device)", () => {
  it("is read-only while both partitions are live, then takes over a lapsed one", async () => {
    const NOW = 5_000_000

    // Devices A and B hold both partitions with live leases.
    const leaseA = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
    })
    expect(
      (await leaseA.acquire({ partitionCount: PARTITION_COUNT })).partition,
    ).toBe(0)

    const leaseB = makeLease({
      deviceId: DEVICE_B,
      bee: bee as unknown as Bee,
      now: () => NOW + 1000,
    })
    expect(
      (await leaseB.acquire({ partitionCount: PARTITION_COUNT })).partition,
    ).toBe(1)

    // 3rd device: one instance whose clock advances across attempts, mirroring
    // the proxy holding a single lease and re-running the slot-wait acquire.
    let cNow = NOW + 2000
    const DEVICE_C = "device-gamma-333"
    const leaseC = makeLease({
      deviceId: DEVICE_C,
      bee: bee as unknown as Bee,
      now: () => cNow,
    })

    // Both partitions live → read-only, no slot.
    const readOnly = await leaseC.acquire({ partitionCount: PARTITION_COUNT })
    expect(readOnly.partition).toBeUndefined()
    expect(readOnly.isReadOnly).toBe(true)

    // B refreshes before its lease expires (while A is still live), extending
    // p1 well past A's expiry. A goes idle and never refreshes → it lapses at
    // NOW + LEASE_TTL_MS.
    const leaseBRefresh = makeLease({
      deviceId: DEVICE_B,
      bee: bee as unknown as Bee,
      now: () => NOW + LEASE_TTL_MS - 5_000,
    })
    expect(
      (await leaseBRefresh.acquire({ partitionCount: PARTITION_COUNT }))
        .partition,
    ).toBe(1)

    // C retries after A's lease has lapsed but while B's refreshed lease is live.
    cNow = NOW + LEASE_TTL_MS + 2_000
    const tookOver = await leaseC.acquire({ partitionCount: PARTITION_COUNT })
    expect(tookOver.partition).toBe(0) // A's freed slot
    expect(tookOver.isReadOnly).toBe(false)

    const p0 = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(p0?.holderDeviceId).toBe(DEVICE_C)
  })
})

describe("PartitionLease.refresh", () => {
  it("returns true and extends leasedUntil", async () => {
    const NOW1 = 1_000_000
    let nowValue = NOW1
    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => nowValue,
    })
    await lease.acquire({ partitionCount: PARTITION_COUNT })

    nowValue = NOW1 + 10_000
    const ok = await lease.refresh()
    expect(ok).toBe(true)

    const observed = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(observed?.holderDeviceId).toBe(DEVICE_A)
    expect(observed?.leasedUntil).toBe(nowValue + LEASE_TTL_MS)
  })

  it("returns false when no lease is held", async () => {
    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    expect(await lease.refresh()).toBe(false)
  })
})

describe("PartitionLease.release", () => {
  it("writes the NO_HOLDER_DEVICE_ID sentinel to the lock SOC", async () => {
    const NOW = 1_000_000
    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
    })
    await lease.acquire({ partitionCount: PARTITION_COUNT })

    await lease.release(new Uint32Array(NUM_BUCKETS))

    const observed = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(observed?.holderDeviceId).toBe(NO_HOLDER_DEVICE_ID)
  })

  it("a peer can immediately take over after release", async () => {
    const NOW = 1_000_000
    const leaseA = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
    })
    await leaseA.acquire({ partitionCount: PARTITION_COUNT })
    await leaseA.release(new Uint32Array(NUM_BUCKETS))

    const leaseB = makeLease({
      deviceId: DEVICE_B,
      bee: bee as unknown as Bee,
      now: () => NOW + 1000,
    })
    const rB = await leaseB.acquire({ partitionCount: PARTITION_COUNT })
    expect(rB.partition).toBe(0)
  })

  it("no-op when no lease is held", async () => {
    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    await expect(
      lease.release(new Uint32Array(NUM_BUCKETS)),
    ).resolves.toBeUndefined()
  })
})

describe("PartitionLease.refreshFromSwarm / isActive / heldPartition", () => {
  it("reports live holders across partitions", async () => {
    const NOW = 5_000_000
    const stamper = createMockStamper() as unknown as Stamper
    // DEVICE_B holds partition 1 (live).
    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 1,
      payload: {
        holderDeviceId: DEVICE_B,
        generation: {
          timestampMs: NOW,
          tiebreaker: makeDeviceTiebreaker(DEVICE_B),
        },
        acquiredAt: NOW,
        leasedUntil: NOW + LEASE_TTL_MS,
      },
    })

    // DEVICE_A acquires partition 0.
    const leaseA = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW + 1000,
    })
    await leaseA.acquire({ partitionCount: PARTITION_COUNT })

    await leaseA.refreshFromSwarm(PARTITION_COUNT)
    expect(leaseA.isActive(DEVICE_A)).toBe(true)
    expect(leaseA.isActive(DEVICE_B)).toBe(true)
    expect(leaseA.heldPartition()).toBe(0)
  })
})

describe("PartitionLease.serialize / hydrate", () => {
  it("round-trips self and ignores a foreign-device snapshot", async () => {
    const NOW = 1_000_000
    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
    })
    await lease.acquire({ partitionCount: PARTITION_COUNT })
    const snap = lease.serialize()
    expect(snap.deviceId).toBe(DEVICE_A)
    expect(snap.self?.partition).toBe(0)

    // A fresh instance hydrated from the snapshot sees the same partition.
    const fresh = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    fresh.hydrate(snap)
    expect(fresh.currentPartition).toBe(0)

    // A different device ignores the snapshot.
    const other = makeLease({ deviceId: DEVICE_B, bee: bee as unknown as Bee })
    other.hydrate(snap)
    expect(other.currentPartition).toBeUndefined()
  })
})

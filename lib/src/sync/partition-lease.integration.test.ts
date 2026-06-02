// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the consolidated `PartitionLease`.
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
import {
  LEASE_TTL_MS,
  PARTITION_COUNT,
  NUM_BUCKETS,
} from "../utils/batch-utilization"
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

    expect(result.localCounter[100]).toBe(5)
    expect(result.localCounter[200]).toBe(12)
    expect(result.localCounter[0]).toBe(0)
  })

  it("returns a fresh zero counter when the feed entry is unreadable", async () => {
    const { readPartitionState, makePartitionStateTopic } =
      await import("./partition-state")
    const { BasicEpochUpdater } = await import("../proxy/feeds/epochs")

    // Point the partition-state feed at a reference that resolves to nothing
    // (e.g. an old-format or corrupt entry). The reference-chunk download then
    // fails — readPartitionState must NOT throw (it would abort the caller's
    // acquisition), but fall back to a fresh zero counter.
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

    expect(result.localCounter[0]).toBe(0)
    expect(result.localCounter[1234]).toBe(0)
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

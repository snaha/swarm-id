// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the partition-lease orchestrator (iteration 2).
 *
 * Uses MockBee + mockFetch so that `acquirePartitionLock`,
 * `readPartitionLock`, `writePartitionLock`, `readPartitionState`, and
 * `writePartitionState` run against an in-memory chunk store. Tests focus
 * on the public behaviour of `PartitionLease` — they don't poke at the
 * underlying iteration-2 lock SOC except where it makes a scenario more
 * concrete.
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
  computeResumeCounterSkew,
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
  it("reads back counters with skew applied", async () => {
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
      partition: 0,
      localCounter,
      deviceId: DEVICE_A,
      swarmEncryptionKey: TEST_ENC_KEY,
      backupSigner: BACKUP_SIGNER,
    })

    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })

    const skew = computeResumeCounterSkew(TEST_BATCH_DEPTH)
    expect(result.localCounter[100]).toBe(5 + skew)
    expect(result.localCounter[200]).toBe(12 + skew)
    expect(result.localCounter[0]).toBe(0 + skew)
  })
})

describe("PartitionLease.acquire — legacy fall-through", () => {
  it("partitionCount=1 returns undefined partition with no Swarm activity", async () => {
    const spy = vi.spyOn(bee, "downloadChunk")
    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    const result = await lease.acquire({
      activeDevices: [],
      partitionCount: 1,
    })
    expect(result.partition).toBeUndefined()
    expect(result.isReadOnly).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("PartitionLease.acquire — fresh device (no selfEntry)", () => {
  it("picks partition 0 when no lock SOCs exist", async () => {
    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    const result = await lease.acquire({
      activeDevices: [],
      partitionCount: PARTITION_COUNT,
    })
    expect(result.partition).toBe(0)
    expect(result.isReadOnly).toBe(false)
    expect(result.activeDevices).toContainEqual({
      deviceId: DEVICE_A,
      partition: 0,
    })

    // Lock SOC now reflects DEVICE_A as holder.
    const observed = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(observed?.holderDeviceId).toBe(DEVICE_A)
  })

  it("skips over a live foreign holder and picks the next partition", async () => {
    // Pre-seed: DEVICE_B holds partition 0 with a fresh lease.
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
    const result = await lease.acquire({
      activeDevices: [{ deviceId: DEVICE_B, partition: 0 }],
      partitionCount: PARTITION_COUNT,
    })
    expect(result.partition).toBe(1)
    expect(result.isReadOnly).toBe(false)
  })

  it("takes over an expired foreign holder (Case D)", async () => {
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
    const result = await lease.acquire({
      activeDevices: [{ deviceId: DEVICE_B, partition: 0 }],
      partitionCount: PARTITION_COUNT,
    })
    expect(result.partition).toBe(0)
    expect(result.activeDevices).toContainEqual({
      deviceId: DEVICE_A,
      partition: 0,
    })

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
    const result = await lease.acquire({
      activeDevices: Array.from({ length: PARTITION_COUNT }, (_, p) => ({
        deviceId: DEVICE_B,
        partition: p,
      })),
      partitionCount: PARTITION_COUNT,
    })
    expect(result.partition).toBeUndefined()
    expect(result.isReadOnly).toBe(true)
  })
})

describe("PartitionLease.acquire — returning device (selfEntry present)", () => {
  it("re-claims its existing partition (refresh-via-acquire)", async () => {
    const NOW1 = 1_000_000
    const NOW2 = NOW1 + 5_000

    // First session — fresh acquire.
    const lease1 = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW1,
    })
    const r1 = await lease1.acquire({
      activeDevices: [],
      partitionCount: PARTITION_COUNT,
    })
    expect(r1.partition).toBe(0)

    // Second session — selfEntry present. Refresh-via-acquire.
    const lease2 = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW2,
    })
    const r2 = await lease2.acquire({
      activeDevices: [{ deviceId: DEVICE_A, partition: 0 }],
      partitionCount: PARTITION_COUNT,
    })
    expect(r2.partition).toBe(0)
    expect(r2.lockPayload?.generation.timestampMs).toBeGreaterThan(NOW1)
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
    const rA = await leaseA.acquire({
      activeDevices: [],
      partitionCount: PARTITION_COUNT,
    })
    expect(rA.partition).toBe(0)

    const leaseB = makeLease({
      deviceId: DEVICE_B,
      bee: bee as unknown as Bee,
      now: () => NOW + 1000,
    })
    const rB = await leaseB.acquire({
      activeDevices: [{ deviceId: DEVICE_A, partition: 0 }],
      partitionCount: PARTITION_COUNT,
    })
    expect(rB.partition).toBe(1)
    expect(rA.partition).not.toBe(rB.partition)
  })
})

describe("PartitionLease.refresh", () => {
  it("returns updated generation and extends leasedUntil", async () => {
    const NOW1 = 1_000_000
    let nowValue = NOW1
    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => nowValue,
    })
    await lease.acquire({ activeDevices: [], partitionCount: PARTITION_COUNT })

    nowValue = NOW1 + 10_000
    const refreshed = await lease.refresh()
    expect(refreshed).toBeDefined()
    expect(refreshed!.generation).toBeGreaterThanOrEqual(nowValue)

    const observed = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(observed?.holderDeviceId).toBe(DEVICE_A)
    expect(observed?.leasedUntil).toBe(nowValue + LEASE_TTL_MS)
  })

  it("returns undefined when no lease is held", async () => {
    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    const refreshed = await lease.refresh()
    expect(refreshed).toBeUndefined()
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
    await lease.acquire({ activeDevices: [], partitionCount: PARTITION_COUNT })

    const localCounter = new Uint32Array(NUM_BUCKETS)
    await lease.release(localCounter)

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
    await leaseA.acquire({
      activeDevices: [],
      partitionCount: PARTITION_COUNT,
    })
    await leaseA.release(new Uint32Array(NUM_BUCKETS))

    const leaseB = makeLease({
      deviceId: DEVICE_B,
      bee: bee as unknown as Bee,
      now: () => NOW + 1000,
    })
    const rB = await leaseB.acquire({
      activeDevices: [{ deviceId: DEVICE_A, partition: 0 }],
      partitionCount: PARTITION_COUNT,
    })
    // Sentinel is treated as "no holder" so B picks partition 0.
    expect(rB.partition).toBe(0)
  })

  it("no-op when no lease is held", async () => {
    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    await expect(
      lease.release(new Uint32Array(NUM_BUCKETS)),
    ).resolves.toBeUndefined()
  })
})

describe("PartitionLease.hydrate + refresh", () => {
  it("hydrated state survives a session and refresh updates the on-Swarm lock", async () => {
    const ACQUIRED_AT = 1_000_000
    const NOW = ACQUIRED_AT + 1_000
    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
    })
    lease.hydrate({
      partition: 0,
      generation: ACQUIRED_AT,
      acquiredAt: ACQUIRED_AT,
      leasedUntil: ACQUIRED_AT + LEASE_TTL_MS,
    })
    expect(lease.currentPartition).toBe(0)

    const refreshed = await lease.refresh()
    expect(refreshed).toBeDefined()

    const observed = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(observed?.holderDeviceId).toBe(DEVICE_A)
  })
})

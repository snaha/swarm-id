// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest"
import { BatchId, Bee, PrivateKey } from "@ethersphere/bee-js"
import type { Stamper } from "@ethersphere/bee-js"
import { PartitionLease } from "./partition-lease"
import {
  LEASE_TTL_MS,
  NUM_BUCKETS,
  PARTITION_COUNT,
} from "../utils/batch-utilization"
import type { PartitionClaim } from "../schemas"

const TEST_BATCH_ID = new BatchId("11".repeat(32))
const TEST_BATCH_DEPTH = 24
const TEST_ENC_KEY = new Uint8Array(32).map((_, i) => (i + 1) & 0xff)
const TEST_BACKUP_SIGNER = new PrivateKey(
  new Uint8Array(32).map((_, i) => (i * 3 + 5) & 0xff),
)
const SELF_DEVICE_ID = "self-device-aaa"
const OTHER_DEVICE_ID = "other-device-bbb"
const ACCOUNT_ID = "0xc0c0".padEnd(40, "0")

// ============================================================================
// Mocks
// ============================================================================

const claimReads = new Map<string, PartitionClaim | undefined>()
const claimWrites: Array<{
  deviceId: string
  claim: PartitionClaim
}> = []
const stateReads = new Map<
  number,
  { localCounter: Uint32Array; publishedBy?: string }
>()
const stateWrites: Array<{
  partition: number
  localCounter: Uint32Array
  deviceId: string
}> = []

vi.mock("./partition-claim", () => ({
  readDeviceClaim: vi.fn(async (opts: { deviceId: string }) =>
    claimReads.get(opts.deviceId),
  ),
  writeDeviceClaim: vi.fn(
    async (opts: { deviceId: string; claim: PartitionClaim }) => {
      claimWrites.push({ deviceId: opts.deviceId, claim: opts.claim })
      claimReads.set(opts.deviceId, opts.claim)
      return {
        socAddress: new Uint8Array(32).fill(0xaa),
        epoch: { start: 0n, level: 32 },
        timestamp: 1n,
      }
    },
  ),
  NO_CLAIM_PARTITION: -1,
}))

vi.mock("./partition-state", () => ({
  readPartitionState: vi.fn(async (opts: { partition: number }) => {
    const stored = stateReads.get(opts.partition)
    if (stored) {
      return {
        localCounter: stored.localCounter,
        publishedBy: stored.publishedBy,
      }
    }
    // Fresh partition: zero counters (skew skipped for test simplicity).
    return { localCounter: new Uint32Array(NUM_BUCKETS) }
  }),
  writePartitionState: vi.fn(
    async (opts: {
      partition: number
      localCounter: Uint32Array
      deviceId: string
    }) => {
      stateWrites.push({
        partition: opts.partition,
        localCounter: new Uint32Array(opts.localCounter),
        deviceId: opts.deviceId,
      })
      stateReads.set(opts.partition, {
        localCounter: new Uint32Array(opts.localCounter),
        publishedBy: opts.deviceId,
      })
    },
  ),
}))

// ============================================================================
// Test helpers
// ============================================================================

function makeLease(opts: { now?: () => number } = {}): PartitionLease {
  // The Bee/Stamper objects are never actually called because we've mocked
  // the read/write helpers — pass minimal stubs.
  return new PartitionLease({
    bee: {} as Bee,
    accountId: ACCOUNT_ID,
    deviceId: SELF_DEVICE_ID,
    batchId: TEST_BATCH_ID,
    batchDepth: TEST_BATCH_DEPTH,
    swarmEncryptionKey: TEST_ENC_KEY,
    backupSigner: TEST_BACKUP_SIGNER,
    stamper: {} as Stamper,
    now: opts.now,
  })
}

beforeEach(() => {
  claimReads.clear()
  claimWrites.length = 0
  stateReads.clear()
  stateWrites.length = 0
})

// ============================================================================
// Tests
// ============================================================================

describe("PartitionLease.acquire", () => {
  it("Case A: empty activeDevices + partitionCount=2 → self takes partition 0", async () => {
    const lease = makeLease({ now: () => 100_000 })
    const result = await lease.acquire({
      activeDevices: [],
      partitionCount: PARTITION_COUNT,
    })

    expect(result.partition).toBe(0)
    expect(result.partitionCount).toBe(PARTITION_COUNT)
    expect(result.isReadOnly).toBe(false)
    expect(result.localCounter.length).toBe(NUM_BUCKETS)
    expect(result.activeDevices).toEqual([
      { deviceId: SELF_DEVICE_ID, partition: 0 },
    ])

    // Wrote a fresh claim for self with partition 0 and a future leasedUntil.
    expect(claimWrites).toHaveLength(1)
    expect(claimWrites[0].deviceId).toBe(SELF_DEVICE_ID)
    expect(claimWrites[0].claim.partition).toBe(0)
    expect(claimWrites[0].claim.leasedUntil).toBe(100_000 + LEASE_TTL_MS)
    expect(claimWrites[0].claim.generation).toBeGreaterThan(0)
  })

  it("Case B: peer holds p=0 live → self auto-acquires partition 1", async () => {
    const NOW = 200_000
    // Peer has a live claim — leasedUntil > now.
    claimReads.set(OTHER_DEVICE_ID, {
      partition: 0,
      leasedUntil: NOW + LEASE_TTL_MS,
      generation: 1,
      acquiredAt: NOW - 60_000,
    })
    const lease = makeLease({ now: () => NOW })
    const result = await lease.acquire({
      activeDevices: [{ deviceId: OTHER_DEVICE_ID, partition: 0 }],
      partitionCount: PARTITION_COUNT,
    })

    expect(result.partition).toBe(1)
    expect(result.isReadOnly).toBe(false)
    expect(result.activeDevices).toEqual([
      { deviceId: OTHER_DEVICE_ID, partition: 0 },
      { deviceId: SELF_DEVICE_ID, partition: 1 },
    ])
    expect(claimWrites).toHaveLength(1)
    expect(claimWrites[0].deviceId).toBe(SELF_DEVICE_ID)
    expect(claimWrites[0].claim.partition).toBe(1)
  })

  it("Case D: peer holds p=0 with expired lease → self takes over partition 0", async () => {
    const NOW = 300_000
    // Peer's lease has expired.
    claimReads.set(OTHER_DEVICE_ID, {
      partition: 0,
      leasedUntil: NOW - 10_000,
      generation: 7,
      acquiredAt: NOW - 7_200_000,
    })
    const lease = makeLease({ now: () => NOW })
    const result = await lease.acquire({
      activeDevices: [
        { deviceId: OTHER_DEVICE_ID, partition: 0 },
        { deviceId: "third-device-ccc", partition: 1 },
      ],
      partitionCount: PARTITION_COUNT,
    })

    // The third device's claim feed wasn't pre-populated, so its claim is
    // undefined — the orchestrator treats that as "expired" and takes p=1
    // first (lowest-numbered occupied partition iterated first). To force
    // Case D specifically on partition 0, pre-populate the third device's
    // claim as live so only partition 0 is reclaimable.
    expect([0, 1]).toContain(result.partition)
    expect(result.isReadOnly).toBe(false)

    // Self replaces the expired device in activeDevices.
    expect(
      result.activeDevices.some((d) => d.deviceId === SELF_DEVICE_ID),
    ).toBe(true)
    expect(claimWrites).toHaveLength(1)
    expect(claimWrites[0].deviceId).toBe(SELF_DEVICE_ID)
  })

  it("Case D (explicit): only the expired-lease partition becomes reclaimable", async () => {
    const NOW = 350_000
    // Peer A (p=0): expired.
    claimReads.set(OTHER_DEVICE_ID, {
      partition: 0,
      leasedUntil: NOW - 5_000,
      generation: 2,
      acquiredAt: NOW - 7_200_000,
    })
    // Peer C (p=1): live.
    claimReads.set("third-device-ccc", {
      partition: 1,
      leasedUntil: NOW + LEASE_TTL_MS,
      generation: 3,
      acquiredAt: NOW - 60_000,
    })

    const lease = makeLease({ now: () => NOW })
    const result = await lease.acquire({
      activeDevices: [
        { deviceId: OTHER_DEVICE_ID, partition: 0 },
        { deviceId: "third-device-ccc", partition: 1 },
      ],
      partitionCount: PARTITION_COUNT,
    })

    expect(result.partition).toBe(0)
    expect(result.isReadOnly).toBe(false)
    expect(result.activeDevices).toContainEqual({
      deviceId: SELF_DEVICE_ID,
      partition: 0,
    })
    // The live peer stays put.
    expect(result.activeDevices).toContainEqual({
      deviceId: "third-device-ccc",
      partition: 1,
    })
  })

  it("all partitions live and held → returns read-only without writing a claim", async () => {
    const NOW = 400_000
    claimReads.set(OTHER_DEVICE_ID, {
      partition: 0,
      leasedUntil: NOW + LEASE_TTL_MS,
      generation: 1,
      acquiredAt: NOW - 60_000,
    })
    claimReads.set("third-device-ccc", {
      partition: 1,
      leasedUntil: NOW + LEASE_TTL_MS,
      generation: 1,
      acquiredAt: NOW - 60_000,
    })

    const lease = makeLease({ now: () => NOW })
    const result = await lease.acquire({
      activeDevices: [
        { deviceId: OTHER_DEVICE_ID, partition: 0 },
        { deviceId: "third-device-ccc", partition: 1 },
      ],
      partitionCount: PARTITION_COUNT,
    })

    expect(result.partition).toBe(undefined)
    expect(result.isReadOnly).toBe(true)
    expect(claimWrites).toHaveLength(0)
  })

  it("legacy fall-through: partitionCount=1 → no feed traffic, undefined partition", async () => {
    const lease = makeLease()
    const result = await lease.acquire({
      activeDevices: [],
      partitionCount: 1,
    })

    expect(result.partition).toBe(undefined)
    expect(result.partitionCount).toBe(1)
    expect(result.isReadOnly).toBe(false)
    expect(claimWrites).toHaveLength(0)
    expect(stateWrites).toHaveLength(0)
  })

  it("self in activeDevices: re-seeds partition from state feed and re-claims", async () => {
    const NOW = 500_000
    // Self already has a partition assignment in the snapshot.
    const priorClaim: PartitionClaim = {
      partition: 1,
      leasedUntil: NOW - 100, // stale; we always re-claim on acquire
      generation: 5,
      acquiredAt: NOW - 300_000,
    }
    claimReads.set(SELF_DEVICE_ID, priorClaim)

    // Partition state for p=1 has some non-trivial counters.
    const priorCounter = new Uint32Array(NUM_BUCKETS)
    priorCounter[42] = 7
    stateReads.set(1, {
      localCounter: priorCounter,
      publishedBy: SELF_DEVICE_ID,
    })

    const lease = makeLease({ now: () => NOW })
    const result = await lease.acquire({
      activeDevices: [{ deviceId: SELF_DEVICE_ID, partition: 1 }],
      partitionCount: PARTITION_COUNT,
    })

    expect(result.partition).toBe(1)
    expect(result.localCounter[42]).toBe(7)
    expect(claimWrites).toHaveLength(1)
    // Generation strictly increases across reboots.
    expect(claimWrites[0].claim.generation).toBeGreaterThan(
      priorClaim.generation,
    )
  })
})

describe("PartitionLease.release", () => {
  it("publishes partition state and writes a release claim", async () => {
    const lease = makeLease({ now: () => 600_000 })
    await lease.acquire({
      activeDevices: [],
      partitionCount: PARTITION_COUNT,
    })

    const finalCounter = new Uint32Array(NUM_BUCKETS)
    finalCounter[100] = 12
    await lease.release(finalCounter)

    // State feed got the final counter.
    expect(stateWrites).toHaveLength(1)
    expect(stateWrites[0].partition).toBe(0)
    expect(stateWrites[0].localCounter[100]).toBe(12)
    // Two claim writes: the initial acquire + the release.
    expect(claimWrites).toHaveLength(2)
    expect(claimWrites[1].claim.partition).toBe(-1)
  })

  it("no-op when no lease is held (legacy mode)", async () => {
    const lease = makeLease()
    await lease.acquire({
      activeDevices: [],
      partitionCount: 1,
    })
    await lease.release(new Uint32Array(NUM_BUCKETS))
    expect(stateWrites).toHaveLength(0)
    expect(claimWrites).toHaveLength(0)
  })
})

describe("PartitionLease.refresh", () => {
  it("bumps leasedUntil and generation on a held lease", async () => {
    const NOW = 700_000
    let now = NOW
    const lease = makeLease({ now: () => now })
    await lease.acquire({
      activeDevices: [],
      partitionCount: PARTITION_COUNT,
    })
    const initialGen = claimWrites[0].claim.generation
    const initialLeasedUntil = claimWrites[0].claim.leasedUntil

    // Advance the mock clock and refresh.
    now = NOW + 10_000
    await lease.refresh()

    expect(claimWrites).toHaveLength(2)
    expect(claimWrites[1].claim.generation).toBe(initialGen + 1)
    expect(claimWrites[1].claim.leasedUntil).toBeGreaterThan(initialLeasedUntil)
  })

  it("no-op when no lease is held", async () => {
    const lease = makeLease()
    await lease.refresh()
    expect(claimWrites).toHaveLength(0)
  })
})

describe("PartitionLease.currentPartition", () => {
  it("reflects acquire and release", async () => {
    const lease = makeLease()
    expect(lease.currentPartition).toBe(undefined)
    await lease.acquire({
      activeDevices: [],
      partitionCount: PARTITION_COUNT,
    })
    expect(lease.currentPartition).toBe(0)
    await lease.release(new Uint32Array(NUM_BUCKETS))
    expect(lease.currentPartition).toBe(undefined)
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reserved-slot bucket-collision regression for `writePartitionState`.
 *
 * Every reserved-slot write for partition `p` lands at stamp index
 * `(bucket, slot=p)` on the shared batch: the lock SOC, the counter chunks, the
 * reference chunk, the rotating state-pointer SOC, and the intent/occupancy
 * beacons. Two different chunks at the same `(bucket, p)` make Bee's
 * newer-stamp-wins replacement evict one of them. The publish therefore must
 * pick its randomly-keyed counter/reference chunks in buckets distinct from the
 * pointer it writes in the same round AND the beacons the off-lock refresh tick
 * writes concurrently.
 *
 * The collision is a ~1/65536 random event in production, so these tests force
 * it deterministically by mocking the one randomness source
 * (`makeEncryptedContentAddressedChunk`): the first chunk the publish generates
 * is steered into a chosen reserved-slot bucket, and we assert the publish does
 * NOT place a chunk there (it must re-pick a clear bucket).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BatchId, PrivateKey, Reference, type Bee } from "@ethersphere/bee-js"

// Steers the NEXT generated chunk address into `bucket` (consumed once), so a
// test can force a collision with a specific reserved-slot bucket. `vi.hoisted`
// makes it available to the hoisted `vi.mock` factory below.
const force = vi.hoisted(() => ({ bucket: undefined as number | undefined }))

vi.mock("../chunk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chunk")>()
  return {
    ...actual,
    makeEncryptedContentAddressedChunk: (
      payload: Uint8Array | string,
      key?: Uint8Array,
    ) => {
      const real = actual.makeEncryptedContentAddressedChunk(payload, key)
      if (force.bucket === undefined) return real
      const target = force.bucket
      force.bucket = undefined
      // Rewrite only the first two address bytes (the bucket); keep the rest so
      // the address stays otherwise-unique. `reference = address ‖ key`.
      const addr = real.address.toUint8Array().slice()
      addr[0] = (target >>> 8) & 0xff
      addr[1] = target & 0xff
      const reference = new Uint8Array(64)
      reference.set(addr, 0)
      reference.set(real.encryptionKey, 32)
      return {
        ...real,
        address: new Reference(addr),
        reference: new Reference(reference),
      }
    },
  }
})

import { statePointerAddress, writePartitionState } from "./partition-state"
import {
  intentEpochBucket,
  partitionOccupancyAddress,
} from "./partition-intent"
import {
  NUM_BUCKETS,
  PARTITION_COUNT,
  UtilizationAwareStamper,
  toBucket,
} from "../utils/batch-utilization"
import { lockSocBucket } from "../utils/lock-soc"
import {
  MockBee,
  MockChunkStore,
  createTestSigner,
  mockFetch,
} from "../proxy/feeds/epochs/test-utils"

const TEST_BATCH_ID = new BatchId("ab".repeat(32))
const TEST_BATCH_DEPTH = 24
const TEST_ENC_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)
const BACKUP_SIGNER = createTestSigner() as PrivateKey
const OWNER = BACKUP_SIGNER.publicKey().address()
const PARTITION = 0
const DEVICE_ID = "device-A"

let store: MockChunkStore
let bee: MockBee

beforeEach(() => {
  store = new MockChunkStore()
  bee = new MockBee(store)
  mockFetch(store, OWNER)
})

afterEach(() => {
  vi.restoreAllMocks()
  force.bucket = undefined
})

async function makeBoundStamper(): Promise<UtilizationAwareStamper> {
  const cache = {
    getAllChunks: async () => [],
    putChunk: async () => undefined,
  } as unknown as Parameters<typeof UtilizationAwareStamper.create>[3]
  const stamper = await UtilizationAwareStamper.create(
    "11".repeat(32),
    TEST_BATCH_ID,
    TEST_BATCH_DEPTH,
    cache,
    OWNER,
    TEST_ENC_KEY,
  )
  stamper.bindPartition({
    partition: PARTITION,
    partitionCount: PARTITION_COUNT,
    localCounter: new Uint32Array(NUM_BUCKETS),
  })
  return stamper
}

/** Publish a counter with exactly one non-zero chunk (one counter-chunk PUT). */
async function publishOneChunk(
  stamper: UtilizationAwareStamper,
  nowMs: number,
): Promise<number[]> {
  const localCounter = new Uint32Array(NUM_BUCKETS)
  localCounter[1000] = 1
  vi.spyOn(Date, "now").mockReturnValue(nowMs)
  const result = await writePartitionState({
    bee: bee as unknown as Bee,
    stamper,
    batchId: TEST_BATCH_ID,
    batchDepth: TEST_BATCH_DEPTH,
    partition: PARTITION,
    localCounter,
    backupSigner: BACKUP_SIGNER,
    swarmEncryptionKey: TEST_ENC_KEY,
    deviceId: DEVICE_ID,
  })
  return result.stateBuckets
}

describe("writePartitionState — reserved-slot bucket-collision avoidance", () => {
  it("does not place a counter chunk in the state-pointer's bucket", async () => {
    const now = 1_000_000_000_000
    const stamper = await makeBoundStamper()
    const pointerBucket = toBucket(
      statePointerAddress(TEST_BATCH_ID, PARTITION, OWNER, now),
    )
    // Guard: a false green if the target happened to already be claimed.
    expect(pointerBucket).not.toBe(lockSocBucket(PARTITION, OWNER))

    force.bucket = pointerBucket // steer the first counter chunk onto the pointer
    const stateBuckets = await publishOneChunk(stamper, now)

    // The pointer SOC occupies (pointerBucket, slot=PARTITION); a counter/
    // reference chunk there would evict it (or vice versa). The publish must
    // have re-picked a clear bucket.
    expect(stateBuckets).not.toContain(pointerBucket)
  })

  it("does not place a counter chunk in the occupancy beacon's bucket", async () => {
    const now = 1_000_000_000_000
    const stamper = await makeBoundStamper()
    const occupancyBucket = toBucket(
      partitionOccupancyAddress(PARTITION, intentEpochBucket(now), OWNER),
    )
    expect(occupancyBucket).not.toBe(lockSocBucket(PARTITION, OWNER))

    force.bucket = occupancyBucket
    const stateBuckets = await publishOneChunk(stamper, now)

    // The refresh-tick occupancy beacon writes (occupancyBucket, slot=PARTITION)
    // off-lock during this publish; a chunk there would evict the beacon.
    expect(stateBuckets).not.toContain(occupancyBucket)
  })
})

describe("writePartitionState — sparse sentinel refs are independent", () => {
  it("returns a distinct zero-ref instance per never-written chunk", async () => {
    const stamper = await makeBoundStamper()
    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[1000] = 1 // exactly one non-zero chunk → the rest are sentinels

    const { references } = await writePartitionState({
      bee: bee as unknown as Bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: PARTITION,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      deviceId: DEVICE_ID,
    })

    const zeroRefs = references.filter((r) => r.every((b) => b === 0))
    expect(zeroRefs.length).toBeGreaterThan(1)
    // A shared sentinel instance would collapse to size 1 — an in-place byte
    // write to one zero slot would then corrupt every other zero slot.
    expect(new Set(zeroRefs).size).toBe(zeroRefs.length)
  })
})

describe("writePartitionState — distinct-bucket invariant guard", () => {
  it("publishes many chunks into all-distinct reserved buckets", async () => {
    const stamper = await makeBoundStamper()
    // Non-zero buckets across several distinct counter chunks (bucketsPerChunk =
    // 2048 at depth 24), so the publish uploads multiple counter chunks + the
    // reference chunk in one parallel batch — the case the distinct-bucket
    // assertion protects (parallel stamps must not share a bucket).
    const localCounter = new Uint32Array(NUM_BUCKETS)
    for (const b of [100, 3000, 5000, 7000]) localCounter[b] = 1

    const { stateBuckets } = await writePartitionState({
      bee: bee as unknown as Bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: PARTITION,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      deviceId: DEVICE_ID,
    })

    // Every reserved-slot write lands at (bucket, slot=PARTITION); the parallel
    // publish is only race-free because those buckets are all distinct.
    expect(new Set(stateBuckets).size).toBe(stateBuckets.length)
  })
})

describe("writePartitionState — counter monotonicity tripwire", () => {
  it("refuses an incremental publish whose counter regressed below the previous", async () => {
    const stamper = await makeBoundStamper()

    // A first full publish establishes the incremental baseline (refs + counter).
    const baseline = new Uint32Array(NUM_BUCKETS)
    baseline[1000] = 5
    const first = await writePartitionState({
      bee: bee as unknown as Bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: PARTITION,
      localCounter: baseline,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      deviceId: DEVICE_ID,
    })

    // A regressed counter (bucket 1000 dropped 5 → 4) must fail loudly rather
    // than retain a ref describing a value ABOVE the live counter — the "impossible"
    // case the tripwire guards (a takeover would resume past an acked slot).
    const regressed = new Uint32Array(NUM_BUCKETS)
    regressed[1000] = 4
    await expect(
      writePartitionState({
        bee: bee as unknown as Bee,
        stamper,
        batchId: TEST_BATCH_ID,
        batchDepth: TEST_BATCH_DEPTH,
        partition: PARTITION,
        localCounter: regressed,
        backupSigner: BACKUP_SIGNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        deviceId: DEVICE_ID,
        previousReferences: first.references,
        previousCounter: first.publishedCounter,
      }),
    ).rejects.toThrow(/counter regressed/)
  })
})

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
  Reference,
  type Bee,
  type Stamper,
} from "@ethersphere/bee-js"

/**
 * Gate used to park `PartitionLease.release()` between its publish and its
 * sentinel write — exactly the window of the #349 race (a detached release
 * outliving a same-device re-acquire). When `block` is unset the mock is a
 * pure passthrough, so every other test is unaffected.
 */
const releaseGate: { block?: Promise<void>; onEnter?: () => void } = {}
vi.mock("./partition-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./partition-state")>()
  return {
    ...actual,
    writePartitionState: async (
      ...args: Parameters<typeof actual.writePartitionState>
    ) => {
      const result = await actual.writePartitionState(...args)
      releaseGate.onEnter?.()
      if (releaseGate.block) await releaseGate.block
      return result
    },
  }
})
import { PartitionLease } from "./partition-lease"
import {
  acquirePartitionLock,
  deviceHomePartition,
  makeDeviceTiebreaker,
  NO_HOLDER_DEVICE_ID,
  readPartitionLock,
  writePartitionLock,
} from "./partition-lock"
import { makePartitionLockIdentifier } from "../utils/lock-soc"
import {
  INTENT_LIVENESS_GRACE_MS,
  intentEpochBucket,
  readPartitionIntent,
  writePartitionIntent,
  writePartitionOccupancy,
} from "./partition-intent"
import { Binary } from "cafe-utility"
import {
  LEASE_TTL_MS,
  PARTITION_COUNT,
  NUM_BUCKETS,
  getChunkLayout,
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
// Selection scans from each device's deterministic home partition
// (`deviceHomePartition`). These device IDs are chosen so DEVICE_A's home is
// partition 0 at PARTITION_COUNT (2), keeping the selection/fencing scenarios
// below readable in natural partition order. The home-offset spread itself is
// covered directly in partition-lock.test.ts.
const DEVICE_A = "device-alpha-1" // home partition 0 (keccak256 mod 2)
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
 * Publish a state pointer at the current rotating bucket naming `referenceHex` —
 * the test stand-in for "a holder published this resume pointer". Used to seed
 * dangling / malformed pointers for the fail-safe read tests.
 */
async function seedStatePointer(
  referenceHex: string,
  partition = 0,
): Promise<void> {
  const { writeStatePointer } = await import("./partition-state")
  await writeStatePointer({
    bee: bee as unknown as Bee,
    stamper: createMockStamper() as unknown as Stamper,
    backupSigner: BACKUP_SIGNER,
    swarmEncryptionKey: TEST_ENC_KEY,
    batchId: TEST_BATCH_ID,
    partition,
    referenceHex,
    nowMs: Date.now(),
  })
}

function makeLease(opts: {
  deviceId: string
  bee: Bee
  now?: () => number
  knownDeviceIds?: () => string[]
  intentReadTimeoutMs?: number
  intentGuardWindowMs?: number
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
    knownDeviceIds: opts.knownDeviceIds,
    intentReadTimeoutMs: opts.intentReadTimeoutMs,
    // Default the intent-round poll-guard to a single immediate read in tests
    // (MockBee has perfect visibility; the production ~12s window would just
    // stall the suite). Individual tests can override.
    intentGuardWindowMs: opts.intentGuardWindowMs ?? 0,
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
  releaseGate.block = undefined
  releaseGate.onEnter = undefined
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
      swarmEncryptionKey: TEST_ENC_KEY,
    })

    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })

    expect(result.unchanged).toBe(false)
    // The reader reconstructs the exact published counter. No compensation: the
    // state pointer is a reserved-slot SOC, so it consumes no data slot (unlike
    // the old data-slot epoch feed entry).
    expect(result.localCounter).toEqual(localCounter)
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
      swarmEncryptionKey: TEST_ENC_KEY,
    })

    // Sparse publish: only the ONE non-zero counter chunk (bucket 42's chunk)
    // is uploaded, plus the reference chunk — far fewer than
    // numUtilizationChunks (the all-zero chunks are sentinels, never uploaded).
    // All distinct, none on the partition's lock-SOC bucket.
    const { numUtilizationChunks } = getChunkLayout(TEST_BATCH_DEPTH)
    expect(written.stateBuckets).toHaveLength(2) // 1 non-zero counter chunk + ref chunk
    expect(written.stateBuckets.length).toBeLessThan(numUtilizationChunks)
    expect(new Set(written.stateBuckets).size).toBe(2)
    expect(written.stateBuckets).not.toContain(lockSocBucket(0, OWNER))

    // A taking-over device derives the same protection set from the
    // reference chunk it downloads.
    const read = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(new Set(read.stateBuckets)).toEqual(new Set(written.stateBuckets))
  })

  it("returns the per-chunk references (incl. sentinels) for the caller to seed", async () => {
    const { writePartitionState, readPartitionState } =
      await import("./partition-state")
    const { numUtilizationChunks } = getChunkLayout(TEST_BATCH_DEPTH)

    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[100] = 5 // chunk 0
    const stamper = createMockStamper() as unknown as Stamper
    const { referenceHex } = await writePartitionState({
      bee: bee as unknown as Bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
    })

    // Full read: the complete ref set (one real ref + sentinels for the rest),
    // length numUtilizationChunks — exactly what claimPartition seeds as the
    // publish baseline so the first publish is incremental.
    const full = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(full.references).toHaveLength(numUtilizationChunks)

    // Cache hit still returns references (best-effort ref-chunk download), so a
    // reload's re-acquire can seed an incremental first publish too.
    const cached = await readPartitionState(
      {
        bee: bee as unknown as Bee,
        owner: OWNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        batchId: TEST_BATCH_ID,
        partition: 0,
        batchDepth: TEST_BATCH_DEPTH,
      },
      referenceHex,
    )
    expect(cached.unchanged).toBe(true)
    expect(cached.references).toHaveLength(numUtilizationChunks)
    expect(cached.references).toEqual(full.references)
  })

  it("skips the reference + counter-chunk downloads when the pointer is unchanged", async () => {
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
      swarmEncryptionKey: TEST_ENC_KEY,
    })

    const getSpy = vi.spyOn(store, "get")

    // No cached reference → full download.
    const full = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(full.unchanged).toBe(false)
    expect(full.localCounter).toEqual(localCounter)
    expect(full.referenceHex).toBe(writtenRef)
    const callsForFullRead = getSpy.mock.calls.length

    // Same reference cached → skip, reuse local counter, far fewer chunk reads.
    const cached = await readPartitionState(
      {
        bee: bee as unknown as Bee,
        owner: OWNER,
        swarmEncryptionKey: TEST_ENC_KEY,
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

  it("reports readFailed when the pointer's reference chunk is unreadable (no zero-seed)", async () => {
    const { writeStatePointer, readPartitionState } =
      await import("./partition-state")

    // Publish a pointer at the current bucket that names a reference chunk which
    // resolves to nothing (evicted/corrupt). A pointer EXISTS, so the partition
    // has a real resume point we failed to learn — readPartitionState must NOT
    // zero-seed (that would re-issue every used slot); it reports readFailed.
    const danglingRef = Binary.uint8ArrayToHex(new Uint8Array(64).fill(0x99))
    await writeStatePointer({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      referenceHex: danglingRef,
      nowMs: Date.now(),
    })

    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
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
      swarmEncryptionKey: TEST_ENC_KEY,
    })

    // Learn a counter-chunk address by spying on a successful read: the read
    // path fetches the pointer SOC, then the reference chunk, then the counter
    // chunks in order — so the LAST fetched address is a counter chunk.
    const getSpy = vi.spyOn(store, "get")
    const ok = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
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
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(result.readFailed).toBe(true)
    expect(result.localCounter).toBeUndefined()
  })

  it("zero-seeds when no pointer exists and no prior holder is known", async () => {
    const { readPartitionState } = await import("./partition-state")

    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })

    expect(result.readFailed).toBeUndefined()
    expect(result.unchanged).toBe(false)
    expect(result.localCounter![0]).toBe(0)
  })

  it("fails safe (NOT zero) when no pointer is found but the lock was unreadable", async () => {
    const { readPartitionState } = await import("./partition-state")

    // No pointer published AND the lock SOC read was inconclusive (a transient
    // failure, not a clean 404). Resuming from zero here could re-issue a gone
    // holder's acked slots, so the read must degrade to `readFailed` instead —
    // the caller retries read-only rather than claiming-from-zero.
    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
      lockUnreadable: true,
    })

    expect(result.readFailed).toBe(true)
    expect(result.localCounter).toBeUndefined()
  })

  it("still zero-seeds a fresh partition (clean absent lock) even with lockUnreadable false", async () => {
    const { readPartitionState } = await import("./partition-state")

    // A genuinely fresh partition: the lock read returned cleanly absent
    // (lockUnreadable === false), so first-claim from zero must still proceed.
    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
      lockUnreadable: false,
    })

    expect(result.readFailed).toBeUndefined()
    expect(result.localCounter![0]).toBe(0)
  })

  it("finds a pointer published in the holder's leasedUntil bucket even after it ages out of `now`", async () => {
    const { writePartitionState, readPartitionState, statePointerEpochBucket } =
      await import("./partition-state")

    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[7] = 4
    // A holder published (and heartbeated) ~5 minutes ago, then stopped; its
    // lease expired shortly after. The pointer is NOT in the `now` bucket.
    const STATE_EPOCH_MS = 30_000
    const longAgo = Date.now() - 5 * 60_000
    vi.spyOn(Date, "now").mockReturnValue(longAgo)
    await writePartitionState({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
    })
    vi.restoreAllMocks()

    // Reading at `now` with no holder hint misses it (aged out of current/prev).
    expect(statePointerEpochBucket(Date.now())).not.toBe(
      statePointerEpochBucket(longAgo),
    )
    const missed = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(missed.localCounter![7]).toBe(0) // zero-seed (not found)

    // With the gone holder's leasedUntil (≈ publish time + lease TTL), the
    // reader computes the right bucket and resumes exactly.
    const found = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
      holderLeasedUntilMs: longAgo + STATE_EPOCH_MS,
    })
    expect(found.localCounter).toEqual(localCounter)
  })

  it("finds the pointer when leasedUntil is more than one epoch past the last heartbeat (dropped final heartbeats / TTL > epoch)", async () => {
    const { writePartitionState, readPartitionState, statePointerEpochBucket } =
      await import("./partition-state")

    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[7] = 4
    const STATE_EPOCH_MS = 30_000
    // The holder's last DURABLE pointer was written at T0, but its lock SOC's
    // `leasedUntil` then advanced ~2 epochs further — the last couple of
    // best-effort heartbeats were dropped (flaky gateway), or the lease TTL is
    // wider than one pointer epoch. The pointer is NOT in the {leasedUntil,
    // leasedUntil-1} window the old reader probed.
    const T0 = Date.now() - 5 * 60_000
    vi.spyOn(Date, "now").mockReturnValue(T0)
    await writePartitionState({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
    })
    vi.restoreAllMocks()

    const leasedUntil = T0 + 2 * STATE_EPOCH_MS + 1_000
    // The pointer's bucket is ≥2 below the leasedUntil bucket — outside the old
    // ±1 window, inside the full-TTL span the reader must scan.
    expect(
      statePointerEpochBucket(leasedUntil) - statePointerEpochBucket(T0),
    ).toBeGreaterThanOrEqual(2)
    // `now` is ~5 min away, so the current/previous buckets can't mask the miss.
    expect(statePointerEpochBucket(Date.now())).not.toBe(
      statePointerEpochBucket(T0),
    )

    const found = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
      holderLeasedUntilMs: leasedUntil,
    })
    expect(found.localCounter).toEqual(localCounter)
  })
})

describe("PartitionLease.acquire — seeds the incremental first publish", () => {
  it("a fresh lease resumes from the published refs, so its first publish is incremental (one chunk)", async () => {
    const partitionState = await import("./partition-state")
    const { numUtilizationChunks } = getChunkLayout(TEST_BATCH_DEPTH)

    // A prior holder published multi-chunk state (non-zero buckets across three
    // distinct counter chunks; bucketsPerChunk = 2048).
    const published = new Uint32Array(NUM_BUCKETS)
    published[100] = 5 // chunk 0
    published[3000] = 7 // chunk 1
    published[5000] = 9 // chunk 2
    await partitionState.writePartitionState({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter: published,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
    })

    // Observe every writePartitionState from here: the setup write above is
    // already done, so call[0] will be the lease's FIRST publish.
    const writeSpy = vi.spyOn(partitionState, "writePartitionState")

    // A fresh lease acquires partition 0 (no live lock) → full read → seeds
    // publishedReferences/publishedCounter from the resumed state.
    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    const acquired = await lease.acquire({ partitionCount: PARTITION_COUNT })
    expect(acquired.partition).toBe(0)
    expect(acquired.localCounter).toEqual(published)

    // Advance exactly ONE bucket (same chunk 0) and publish.
    const next = acquired.localCounter.slice()
    next[101] += 1
    await lease.publishState(next)

    // The fix: the first publish ran incrementally against the resumed state —
    // it received the full seeded ref set as `previousReferences` (not undefined,
    // which would force a full re-publish of all three non-zero chunks).
    expect(writeSpy).toHaveBeenCalledTimes(1)
    const firstPublishArgs = writeSpy.mock.calls[0][0]
    expect(firstPublishArgs.previousReferences).toHaveLength(
      numUtilizationChunks,
    )
    expect(firstPublishArgs.previousCounter).toEqual(published)

    // ...and it re-uploaded only the changed chunk: the resulting refs differ
    // from the seed at exactly chunk 0 (101 lives in chunk 0); chunks 1 & 2 keep
    // their original refs.
    const seed = firstPublishArgs.previousReferences as Uint8Array[]
    const after = (await writeSpy.mock.results[0].value).references
    const changed = after
      .map((_: Uint8Array, i: number) => i)
      .filter((i: number) => !bytesEqual(after[i], seed[i]))
    expect(changed).toEqual([0])
  })

  it("a resumed holder heartbeats the inherited pointer (acquire seeds lastReferenceHex)", async () => {
    // A prior holder published state on partition 0.
    const partitionState = await import("./partition-state")
    const published = new Uint32Array(NUM_BUCKETS)
    published[100] = 5
    await partitionState.writePartitionState({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter: published,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
    })

    // Resume the partition without ever uploading.
    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    const acquired = await lease.acquire({ partitionCount: PARTITION_COUNT })
    expect(acquired.partition).toBe(0)

    // The heartbeat must re-publish the inherited resume pointer to the current
    // bucket so a later takeover finds it even if this holder never uploads.
    // Without the lastReferenceHex seed it no-ops (the resume point silently ages
    // out of the takeover lookup span → resume-from-zero).
    const pointerSpy = vi.spyOn(partitionState, "writeStatePointer")
    await lease.heartbeatStatePointer()
    expect(pointerSpy).toHaveBeenCalledTimes(1)
  })
})

/** Local byte-equality (the module's `bytesEqual` is not exported). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe("PartitionLease.acquire — unreadable partition state", () => {
  it("degrades to read-only without writing the lock SOC", async () => {
    // Partition 0's state pointer names an unreadable reference.
    await seedStatePointer(
      Binary.uint8ArrayToHex(new Uint8Array(64).fill(0x99)),
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
    const { readPartitionState } = await import("./partition-state")

    const target: UploadTarget = {
      mode: "stamper",
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
    }

    // A readable chunk that is NOT numUtilizationChunks × 64 bytes — e.g. an
    // entry written by a buggy or older writer. Reads must fail safe: a pointer
    // EXISTS, so the partition has a real resume point — a zero counter would
    // re-issue every used slot.
    const malformedRef = await uploadEncryptedBlob(
      target,
      new Uint8Array(32).fill(7),
    )
    await seedStatePointer(Binary.uint8ArrayToHex(malformedRef))

    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
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
    const { readPartitionState } = await import("./partition-state")

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
    await seedStatePointer(Binary.uint8ArrayToHex(referenceChunkRef))

    const result = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
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
        swarmEncryptionKey: TEST_ENC_KEY,
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

  it("resumes the expired holder's published counter on takeover (not a zero counter)", async () => {
    const PAST = 1_000_000
    const NOW = PAST + LEASE_TTL_MS + 10_000
    const { writePartitionState } = await import("./partition-state")

    // DEVICE_B published a non-zero counter while holding p0, ~at PAST. The state
    // pointer is a rotating per-epoch SOC keyed off `Date.now()` (NOT the lease's
    // injected `now`), so mock Date.now to PAST while seeding → the pointer lands
    // in PAST's epoch bucket. The lease later reads at the real wall clock, whose
    // bucket is far past PAST: the pointer is aged out of `now`/`now-1` and is
    // reachable ONLY via the gone holder's `leasedUntil` bucket.
    const published = new Uint32Array(NUM_BUCKETS)
    published[100] = 5
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(PAST)
    await writePartitionState({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter: published,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
    })
    nowSpy.mockRestore()

    // DEVICE_B's lock is expired at NOW (it departed without releasing).
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
    // Regression guard: the takeover must resume B's exact published counter, NOT
    // a zero seed that would re-issue every used slot and evict B's data chunks.
    expect(result.localCounter).toEqual(published)
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

describe("acquirePartitionLock — self-refresh through a frozen-cache read (regression)", () => {
  // On a gateway that serves a partition's static lock SOC from a frozen cache,
  // a holder refreshing its OWN lock writes leasedUntil = now + TTL but the
  // verify-read returns the STALE old chunk. acquirePartitionLock must trust the
  // fresh claim it just wrote, not the stale read-back — otherwise the lease
  // silently never extends (leasedUntil pinned to the old value), the holder
  // believes it still holds while peers see it expire, and a contender takes the
  // slot → both believe they hold it. (Surfaced by the gateway idle-then-reacquire
  // beat in scripts/partition-acquire-3-test.ts.)
  it("returns the freshly-written leasedUntil, not the stale read-back", async () => {
    const T_CLAIM = 1_000_000
    const T_NOW = T_CLAIM + 5_000

    // Seed our own (older-generation) claim on p0.
    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
      payload: {
        holderDeviceId: DEVICE_A,
        generation: {
          timestampMs: T_CLAIM,
          tiebreaker: makeDeviceTiebreaker(DEVICE_A),
        },
        acquiredAt: T_CLAIM,
        leasedUntil: T_CLAIM + LEASE_TTL_MS,
      },
    })

    // Freeze every read of the lock SOC address at that seeded chunk, so the
    // verify-read inside acquirePartitionLock returns the stale claim no matter
    // what we write (the gateway frozen-cache effect). Other reads pass through.
    const lockId = makePartitionLockIdentifier(0)
    const lockAddr = new Reference(
      Binary.keccak256(
        Binary.concatBytes(lockId.toUint8Array(), OWNER.toUint8Array()),
      ),
    )
      .toHex()
      .toLowerCase()
    const realDownload = bee.downloadChunk.bind(bee)
    const frozen = await realDownload(lockAddr)
    vi.spyOn(bee, "downloadChunk").mockImplementation(((
      addr: unknown,
      ...rest: unknown[]
    ) => {
      if (typeof addr === "string" && addr.toLowerCase() === lockAddr) {
        return Promise.resolve(frozen) as never
      }
      return (realDownload as (...a: unknown[]) => unknown)(
        addr,
        ...rest,
      ) as never
    }) as never)

    const result = await acquirePartitionLock({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
      deviceId: DEVICE_A,
      ttlMs: LEASE_TTL_MS,
      guardMs: GUARD_MS,
      now: () => T_NOW,
    })

    expect(result.outcome).toBe("acquired")
    // The lease must extend to now + TTL, NOT stay pinned at the stale read-back.
    expect(result.payload?.leasedUntil).toBe(T_NOW + LEASE_TTL_MS)
  })
})

describe("PartitionLease.acquire — unknown-holder dual-acquire guard (regression)", () => {
  // Reproduces the live failure where Chrome (B) and Brave (C) both held p=1.
  // Timeline from the logs: A holds p0; C takes p1; B comes back NOT knowing C
  // (its device roster hadn't synced C yet) and reads its OWN stale, expired
  // lock for p1 from the frozen gateway cache — so on every knownDeviceIds-keyed
  // channel (lock / intent / presence) B is blind to C and re-claims p1.
  //
  // The invariant: a device must NOT bind a partition a live peer holds, even
  // when that peer is absent from knownDeviceIds AND the static lock read is
  // stale. Today B has no deviceId-independent way to detect C, so this FAILS
  // (B binds p1). The per-partition occupancy beacon is what makes it pass.
  it("does not bind a partition a live UNKNOWN peer holds when the static lock read is stale", async () => {
    const NOW = 5_000_000
    const DEVICE_C = "device-gamma-333"

    // A holds p0 (live, and known to B below).
    const leaseA = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
    })
    expect(
      (await leaseA.acquire({ partitionCount: PARTITION_COUNT })).partition,
    ).toBe(0)

    // C takes p1 (p0 is A's). C is a freshly-joined device B hasn't discovered.
    const leaseC = makeLease({
      deviceId: DEVICE_C,
      bee: bee as unknown as Bee,
      now: () => NOW + 1000,
      knownDeviceIds: () => [DEVICE_A, DEVICE_C],
    })
    expect(
      (await leaseC.acquire({ partitionCount: PARTITION_COUNT })).partition,
    ).toBe(1)

    // Frozen-cache simulation: B's gateway still serves B's OWN stale, expired
    // lock for p1 instead of C's live one (the logs show B reading "EXPIRED
    // holder <self>"). After this overwrite, C's hold survives only on the
    // deviceId-independent occupancy channel the fix adds.
    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 1,
      payload: {
        holderDeviceId: DEVICE_B,
        generation: {
          timestampMs: NOW - 10_000,
          tiebreaker: makeDeviceTiebreaker(DEVICE_B),
        },
        acquiredAt: NOW - 10_000,
        leasedUntil: NOW, // expired by B's clock (NOW + 2000) below
      },
    })

    // B re-acquires while A is still live on p0. It does NOT know C, and its p1
    // lock read is the stale self-claim → it thinks p1 is free. It must detect
    // C and fall back to read-only instead of binding p1.
    const leaseB = makeLease({
      deviceId: DEVICE_B,
      bee: bee as unknown as Bee,
      now: () => NOW + 2000,
      knownDeviceIds: () => [DEVICE_A, DEVICE_B], // C absent — the bug condition
    })
    const rB = await leaseB.acquire({ partitionCount: PARTITION_COUNT })

    expect(rB.partition).toBeUndefined()
    expect(rB.isReadOnly).toBe(true)
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
    expect(ok).toBe("held")

    const observed = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(observed?.holderDeviceId).toBe(DEVICE_A)
    expect(observed?.leasedUntil).toBe(nowValue + LEASE_TTL_MS)
  })

  it("returns 'lost' when no lease is held", async () => {
    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    expect(await lease.refresh()).toBe("lost")
  })
})

describe("writePartitionState — incremental", () => {
  it("re-uploads only changed chunks (unchanged refs retained) and reads back the full counter", async () => {
    const { writePartitionState, readPartitionState } =
      await import("./partition-state")
    const stamper = createMockStamper() as unknown as Stamper
    const { numUtilizationChunks, bucketsPerChunk } =
      getChunkLayout(TEST_BATCH_DEPTH)

    const counter = new Uint32Array(NUM_BUCKETS)
    counter[100] = 5
    const first = await writePartitionState({
      bee: bee as unknown as Bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter: counter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
    })
    expect(first.references).toHaveLength(numUtilizationChunks)

    // Change two buckets that fall in two distinct counter chunks.
    const next = first.publishedCounter.slice()
    next[100] = 9
    next[5000] = 7
    const changed = new Set([
      Math.floor(100 / bucketsPerChunk),
      Math.floor(5000 / bucketsPerChunk),
    ])
    expect(changed.size).toBe(2)

    const second = await writePartitionState({
      bee: bee as unknown as Bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter: next,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      previousReferences: first.references,
      previousCounter: first.publishedCounter,
    })

    // A re-uploaded chunk is re-keyed (fresh random key → new ref); an untouched
    // chunk keeps its prior ref, i.e. it was NOT re-uploaded. This is the
    // incremental guarantee — only the changed chunks hit the network.
    for (let i = 0; i < numUtilizationChunks; i++) {
      const retained =
        Binary.uint8ArrayToHex(second.references[i]) ===
        Binary.uint8ArrayToHex(first.references[i])
      expect(retained, `chunk ${i} retained?`).toBe(!changed.has(i))
    }

    // The taking-over device still reconstructs the FULL counter (changed +
    // retained).
    const read = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(read.localCounter).toEqual(next)
  })

  it("does a full publish when no previous refs are supplied", async () => {
    const { writePartitionState } = await import("./partition-state")
    const stamper = createMockStamper() as unknown as Stamper
    const { numUtilizationChunks } = getChunkLayout(TEST_BATCH_DEPTH)
    const counter = new Uint32Array(NUM_BUCKETS)
    counter[1] = 1
    // previousCounter without previousReferences → NOT incremental.
    const res = await writePartitionState({
      bee: bee as unknown as Bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter: counter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      previousCounter: counter.slice(),
    })
    expect(res.references).toHaveLength(numUtilizationChunks)
    expect(res.references.every((r) => r.length === 64)).toBe(true)
  })
})

describe("PartitionLease.publishState — commit without release", () => {
  it("publishes the counter as the resume point WITHOUT releasing the lock", async () => {
    const NOW = 1_000_000
    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
    })
    const acquired = await lease.acquire({ partitionCount: PARTITION_COUNT })
    expect(acquired.partition).toBe(0)

    // The slots reserved by an upload, committed mid-session (ack-after-publish).
    const counter = new Uint32Array(NUM_BUCKETS)
    counter[100] = 7
    counter[200] = 3
    await lease.publishState(counter)

    // A taking-over device resumes at EXACTLY this counter.
    const { readPartitionState } = await import("./partition-state")
    const read = await readPartitionState({
      bee: bee as unknown as Bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(read.localCounter).toEqual(counter)

    // Unlike release(), publishState keeps the lease: still held, no sentinel.
    expect(lease.currentPartition).toBe(0)
    const observed = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(observed?.holderDeviceId).toBe(DEVICE_A)
  })

  it("is a no-op when no lease is held", async () => {
    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    await expect(
      lease.publishState(new Uint32Array(NUM_BUCKETS)),
    ).resolves.toBeUndefined()
  })
})

describe("PartitionLease.release", () => {
  it("writes the NO_HOLDER_DEVICE_ID sentinel carrying the released claim's generation", async () => {
    const NOW = 1_000_000
    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
    })
    const acquired = await lease.acquire({ partitionCount: PARTITION_COUNT })
    const claimGeneration = acquired.lockPayload!.generation

    await lease.release(new Uint32Array(NUM_BUCKETS))

    const observed = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(observed?.holderDeviceId).toBe(NO_HOLDER_DEVICE_ID)
    // The sentinel is fenced to the claim it releases — it must NOT mint a
    // fresh generation (a fresh one would order above any claim it clobbers).
    expect(observed?.generation).toEqual(claimGeneration)
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

  it("a released partition is not re-marked held by the releaser's lingering presence beacon", async () => {
    // After an explicit release, the releaser's last per-device PRESENCE beacon
    // is still within its lease TTL at a live per-epoch address. A peer that
    // KNOWS the releaser reads that beacon in `refreshHoldersFromPresence`; it
    // must defer to the release sentinel (as the occupancy channel already does)
    // and NOT show the partition as still held — otherwise the holder view, the
    // UI Devices tab, and slot selection all treat a freed partition as taken.
    const NOW = 1_000_000
    const leaseA = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
      knownDeviceIds: () => [DEVICE_A, DEVICE_B],
    })
    await leaseA.acquire({ partitionCount: PARTITION_COUNT })
    await leaseA.release(new Uint32Array(NUM_BUCKETS))

    const leaseB = makeLease({
      deviceId: DEVICE_B,
      bee: bee as unknown as Bee,
      now: () => NOW + 1000,
      knownDeviceIds: () => [DEVICE_A, DEVICE_B],
    })
    await leaseB.refreshFromSwarm(PARTITION_COUNT)
    await leaseB.refreshHoldersFromPresence(PARTITION_COUNT)
    await leaseB.refreshHoldersFromOccupancy(PARTITION_COUNT)

    // DEVICE_A held only partition 0, then released it — no partition is held.
    expect(leaseB.getHolders()).toEqual([])
  })

  it("a peer that KNOWS the releaser acquires the released partition and keeps it across a refresh", async () => {
    // End-to-end of the release-ghost problem: after A releases p0, B (which
    // knows A) must (1) win the intent round despite A's lingering presence
    // beacon and (2) NOT be displaced by that same ghost on its next refresh.
    // Both the intent round and the refresh displacement checks must honor the
    // release watermark (A's ghost generation), not just the holder-detection.
    // Precondition: B's deterministic scan starts at the released partition, so
    // it actually contends for p0 (else it would pick a different free slot).
    expect(deviceHomePartition(DEVICE_B, PARTITION_COUNT)).toBe(0)

    const NOW = 1_000_000
    const leaseA = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
      knownDeviceIds: () => [DEVICE_A, DEVICE_B],
    })
    await leaseA.acquire({ partitionCount: PARTITION_COUNT })
    await leaseA.release(new Uint32Array(NUM_BUCKETS))

    const leaseB = makeLease({
      deviceId: DEVICE_B,
      bee: bee as unknown as Bee,
      now: () => NOW + 1000,
      knownDeviceIds: () => [DEVICE_A, DEVICE_B],
    })
    // (1) Intent round: B wins p0 rather than backing off to read-only.
    const rB = await leaseB.acquire({ partitionCount: PARTITION_COUNT })
    expect(rB.partition).toBe(0)
    expect(rB.isReadOnly).toBe(false)

    // (2) Displacement check: A's ghost (older generation) must not displace B.
    expect(await leaseB.refresh()).toBe("held")
  })

  it("no-op when no lease is held", async () => {
    const lease = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    await expect(
      lease.release(new Uint32Array(NUM_BUCKETS)),
    ).resolves.toBeUndefined()
  })
})

describe("PartitionLease.release — generation fencing (#349)", () => {
  function readLock(partition: number) {
    return readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition,
    })
  }

  it("a detached release outliving a same-device re-acquire does not clobber the successor's claim", async () => {
    const leaseA = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    const first = await leaseA.acquire({ partitionCount: PARTITION_COUNT })
    expect(first.partition).toBe(0)

    // Park the release between its publish and its sentinel write.
    let unblock!: () => void
    releaseGate.block = new Promise<void>((r) => (unblock = r))
    const entered = new Promise<void>((r) => (releaseGate.onEnter = r))
    const releasing = leaseA.release(new Uint32Array(NUM_BUCKETS))
    await entered

    // Same device re-authenticates: a successor lease claims the partition.
    releaseGate.block = undefined
    const leaseA2 = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
    })
    const second = await leaseA2.acquire({ partitionCount: PARTITION_COUNT })
    expect(second.partition).toBe(0)
    const successorGeneration = second.lockPayload!.generation

    // The old release finally completes — its sentinel must be skipped.
    unblock()
    await releasing

    const lock = await readLock(0)
    expect(lock?.holderDeviceId).toBe(DEVICE_A)
    expect(lock?.generation).toEqual(successorGeneration)
  })

  it("a stale release does not clobber a peer's claim after lease expiry", async () => {
    const NOW_A = 1_000_000
    const leaseA = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW_A,
    })
    await leaseA.acquire({ partitionCount: PARTITION_COUNT })

    let unblock!: () => void
    releaseGate.block = new Promise<void>((r) => (unblock = r))
    const entered = new Promise<void>((r) => (releaseGate.onEnter = r))
    const releasing = leaseA.release(new Uint32Array(NUM_BUCKETS))
    await entered

    // A's lease has lapsed from B's point of view; B legitimately claims.
    releaseGate.block = undefined
    const leaseB = makeLease({
      deviceId: DEVICE_B,
      bee: bee as unknown as Bee,
      now: () => NOW_A + LEASE_TTL_MS * 2,
    })
    const b = await leaseB.acquire({ partitionCount: PARTITION_COUNT })
    expect(b.partition).toBe(0)

    unblock()
    await releasing

    const lock = await readLock(0)
    expect(lock?.holderDeviceId).toBe(DEVICE_B)
  })

  it("a refresh overlapping a release aborts instead of minting a ghost claim", async () => {
    const leaseA = makeLease({ deviceId: DEVICE_A, bee: bee as unknown as Bee })
    const acquired = await leaseA.acquire({ partitionCount: PARTITION_COUNT })
    const claimGeneration = acquired.lockPayload!.generation

    let unblock!: () => void
    releaseGate.block = new Promise<void>((r) => (unblock = r))
    const entered = new Promise<void>((r) => (releaseGate.onEnter = r))
    const releasing = leaseA.release(new Uint32Array(NUM_BUCKETS))
    await entered

    // A refresh tick that slipped past teardown: must abort (no ghost claim
    // the fenced release would refuse to clear), not throw.
    await expect(leaseA.refresh()).resolves.toBe("lost")

    unblock()
    await releasing

    // The sentinel landed and is fenced to the ORIGINAL claim — the refresh
    // wrote nothing.
    const lock = await readLock(0)
    expect(lock?.holderDeviceId).toBe(NO_HOLDER_DEVICE_ID)
    expect(lock?.generation).toEqual(claimGeneration)
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

describe("PartitionLease.acquire — intent round (Phase 2)", () => {
  // DEVICE_A's home partition is 0 (see the constant above), so a fresh claim
  // targets partition 0 and the intent round consults rivals for partition 0.
  const NOW = 5_000_000

  it("backs off to read-only when a rival advertises an earlier intent", async () => {
    // A rival announced intent for partition 0 with a SMALLER generation than
    // DEVICE_A will use (timestampMs NOW). No lock SOC exists, so without the
    // intent round DEVICE_A would bind partition 0 — the disjoint-gateway bug.
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
      deviceId: DEVICE_B,
      epochBucket: intentEpochBucket(NOW),
      generation: {
        timestampMs: NOW - 1,
        tiebreaker: makeDeviceTiebreaker(DEVICE_B),
      },
    })

    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
      knownDeviceIds: () => [DEVICE_A, DEVICE_B],
      intentReadTimeoutMs: 50,
    })
    const result = await lease.acquire({ partitionCount: PARTITION_COUNT })

    expect(result.isReadOnly).toBe(true)
    expect(result.partition).toBeUndefined()
    // Crucially: no lock claim was written over the contested partition.
    const lock = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(lock?.holderDeviceId).not.toBe(DEVICE_A)
  })

  it("wins and binds when a rival advertises a later intent", async () => {
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
      deviceId: DEVICE_B,
      epochBucket: intentEpochBucket(NOW),
      generation: {
        timestampMs: NOW + 1,
        tiebreaker: makeDeviceTiebreaker(DEVICE_B),
      },
    })

    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
      knownDeviceIds: () => [DEVICE_A, DEVICE_B],
      intentReadTimeoutMs: 50,
    })
    const result = await lease.acquire({ partitionCount: PARTITION_COUNT })

    expect(result.isReadOnly).toBe(false)
    expect(result.partition).toBe(0)
    const lock = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(lock?.holderDeviceId).toBe(DEVICE_A)
  })

  it("does not run an intent round when re-acquiring our own partition", async () => {
    // First claim with no rivals.
    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
      knownDeviceIds: () => [DEVICE_A, DEVICE_B],
      intentReadTimeoutMs: 50,
    })
    expect(
      (await lease.acquire({ partitionCount: PARTITION_COUNT })).partition,
    ).toBe(0)

    // A rival now advertises an earlier intent — but a re-acquire of a
    // partition we already hold must NOT be gated by the intent round.
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
      deviceId: DEVICE_B,
      epochBucket: intentEpochBucket(NOW),
      generation: {
        timestampMs: NOW - 1,
        tiebreaker: makeDeviceTiebreaker(DEVICE_B),
      },
    })

    const reacquire = await lease.acquire({ partitionCount: PARTITION_COUNT })
    expect(reacquire.partition).toBe(0)
    expect(reacquire.isReadOnly).toBe(false)
  })
})

describe("PartitionLease.acquire — holder presence beacons (gateway holder-exists)", () => {
  // DEVICE_A's home partition is 0. To simulate the gateway (static lock SOC
  // unreadable) we write NO lock SOC, only a foreign holder's presence beacon
  // (an intent SOC carrying `leasedUntil`), and assert the joiner detects it
  // and avoids that partition — the 3-device "join against an existing holder"
  // collision the rework fixes.
  const NOW = 5_000_000

  function writeBeacon(opts: {
    partition: number
    deviceId: string
    epochBucket: number
    leasedUntil: number
    genTimestamp?: number
  }) {
    return writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: opts.partition,
      deviceId: opts.deviceId,
      epochBucket: opts.epochBucket,
      generation: {
        timestampMs: opts.genTimestamp ?? NOW - 1000,
        tiebreaker: makeDeviceTiebreaker(opts.deviceId),
      },
      leasedUntil: opts.leasedUntil,
    })
  }

  function joinerLease() {
    return makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
      knownDeviceIds: () => [DEVICE_A, DEVICE_B],
      intentReadTimeoutMs: 50,
    })
  }

  it("detects a live holder's beacon on its home partition and picks another", async () => {
    await writeBeacon({
      partition: 0,
      deviceId: DEVICE_B,
      epochBucket: intentEpochBucket(NOW),
      leasedUntil: NOW + LEASE_TTL_MS,
    })

    const result = await joinerLease().acquire({
      partitionCount: PARTITION_COUNT,
    })

    expect(result.isReadOnly).toBe(false)
    expect(result.partition).toBe(1) // avoided the held partition 0
    // No claim written on partition 0 by the joiner.
    const p0 = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
    })
    expect(p0?.holderDeviceId).not.toBe(DEVICE_A)
  })

  it("treats a beacon lapsed WITHIN the liveness grace as still held (propagation lag)", async () => {
    // The bug: a live holder's freshest beacon hasn't propagated cross-device,
    // leaving only its previous-bucket beacon whose TTL lapsed seconds ago. A
    // beacon lapsed within grace must keep the partition held so a joiner backs
    // off (else both devices bind the same partition).
    await writeBeacon({
      partition: 0,
      deviceId: DEVICE_B,
      epochBucket: intentEpochBucket(NOW),
      leasedUntil: NOW - 1,
    })

    const result = await joinerLease().acquire({
      partitionCount: PARTITION_COUNT,
    })
    expect(result.partition).toBe(1) // within grace → p0 held → joiner avoids it
  })

  it("treats a beacon lapsed BEYOND the liveness grace as free", async () => {
    await writeBeacon({
      partition: 0,
      deviceId: DEVICE_B,
      epochBucket: intentEpochBucket(NOW),
      leasedUntil: NOW - INTENT_LIVENESS_GRACE_MS - 1,
    })

    const result = await joinerLease().acquire({
      partitionCount: PARTITION_COUNT,
    })
    expect(result.partition).toBe(0) // beyond grace → departed → home wins
  })

  it("detects a live beacon left in the previous epoch bucket (boundary)", async () => {
    await writeBeacon({
      partition: 0,
      deviceId: DEVICE_B,
      epochBucket: intentEpochBucket(NOW) - 1,
      leasedUntil: NOW + LEASE_TTL_MS,
    })

    const result = await joinerLease().acquire({
      partitionCount: PARTITION_COUNT,
    })
    expect(result.partition).toBe(1) // detected via the previous-bucket read
  })

  it("a bare pre-claim intent (no leasedUntil) does NOT mark a partition held", async () => {
    // Same address/bucket as a beacon but WITHOUT leasedUntil — a contender,
    // not a holder. The joiner must still claim the partition (resolved by the
    // intent round), not treat it as held.
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
      deviceId: DEVICE_B,
      epochBucket: intentEpochBucket(NOW),
      generation: {
        timestampMs: NOW + 1000, // later → joiner wins the intent round
        tiebreaker: makeDeviceTiebreaker(DEVICE_B),
      },
      // no leasedUntil
    })

    const result = await joinerLease().acquire({
      partitionCount: PARTITION_COUNT,
    })
    expect(result.partition).toBe(0) // claimed p0 (won the intent round), not avoided
  })

  it("a holder publishes a beacon on acquire (and not when it has no rival)", async () => {
    const withRival = await joinerLease().acquire({
      partitionCount: PARTITION_COUNT,
    })
    expect(withRival.partition).toBe(0)
    const beacon = await readPartitionIntent({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
    })
    expect(beacon?.leasedUntil).toBeGreaterThan(NOW)
  })

  it("publishes a beacon even with no known rivals (so a later-arriving peer can detect it)", async () => {
    // The dual-acquire fix: a device that created the account (knows no peers
    // yet) must still beacon while holding, or a peer who DOES know it finds no
    // beacon and claims the same partition.
    const solo = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
      knownDeviceIds: () => [DEVICE_A],
      intentReadTimeoutMs: 50,
    })
    expect(
      (await solo.acquire({ partitionCount: PARTITION_COUNT })).partition,
    ).toBe(0)
    const beacon = await readPartitionIntent({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: 0,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
    })
    expect(beacon?.leasedUntil).toBeGreaterThan(NOW)
  })

  it("refresh yields when an earlier-generation peer holds the same partition (deconfliction backstop)", async () => {
    // DEVICE_A claims p0 cleanly (no rival beacon yet at acquire).
    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
      knownDeviceIds: () => [DEVICE_A, DEVICE_B],
      intentReadTimeoutMs: 50,
    })
    expect(
      (await lease.acquire({ partitionCount: PARTITION_COUNT })).partition,
    ).toBe(0)

    // A collision slipped past the guard: DEVICE_B holds p0 too, with an EARLIER
    // generation (claimed first). Its beacon has now propagated.
    await writeBeacon({
      partition: 0,
      deviceId: DEVICE_B,
      epochBucket: intentEpochBucket(NOW),
      leasedUntil: NOW + LEASE_TTL_MS,
    })

    // On refresh, DEVICE_A (later generation) detects DEVICE_B and yields.
    // The verdict comes from the per-epoch beacon channel, so it is reported as
    // a CONFIRMED `"displaced"` (not a plain `"lost"`): the coordinator must
    // demote on this without re-reading the static lock SOC, which DEVICE_A
    // just rewrote with its own claim. See the BatchWriteCoordinator test
    // "demotes on a beacon-confirmed displacement …" for the end-to-end guard.
    expect(await lease.refresh()).toBe("displaced")
  })

  it("refresh keeps the lease when only a LATER-generation peer is present", async () => {
    const lease = makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
      knownDeviceIds: () => [DEVICE_A, DEVICE_B],
      intentReadTimeoutMs: 50,
    })
    expect(
      (await lease.acquire({ partitionCount: PARTITION_COUNT })).partition,
    ).toBe(0)

    // DEVICE_B's beacon is LATER than DEVICE_A's claim (DEVICE_A's generation
    // is NOW; give B a later timestamp).
    await writeBeacon({
      partition: 0,
      deviceId: DEVICE_B,
      epochBucket: intentEpochBucket(NOW),
      leasedUntil: NOW + LEASE_TTL_MS,
      genTimestamp: NOW + 1000,
    })
    // DEVICE_A is the earlier holder → keeps the lease.
    expect(await lease.refresh()).toBe("held")
  })
})

describe("PartitionLease.refresh — occupancy displacement vs a PRUNED peer", () => {
  // The dual-acquire that survives `activeDeviceIds` pruning: a live peer whose
  // `lastSignedInAt` aged past KNOWN_DEVICE_MAX_AGE_MS is dropped from
  // `knownDeviceIds`, so the deviceId-keyed `foreignBeaconBeatsUs` is blind to
  // it. The deviceId-INDEPENDENT occupancy beacon is what still resolves the
  // collision in `refresh()`. Here DEVICE_B is deliberately NOT in knownDeviceIds.
  const NOW = 7_000_000

  function writeOccupancy(opts: {
    partition: number
    deviceId: string
    epochBucket: number
    leasedUntil: number
    genTimestamp?: number
  }) {
    return writePartitionOccupancy({
      bee: bee as unknown as Bee,
      stamper: createMockStamper() as unknown as Stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: opts.partition,
      deviceId: opts.deviceId,
      epochBucket: opts.epochBucket,
      generation: {
        timestampMs: opts.genTimestamp ?? NOW - 1000,
        tiebreaker: makeDeviceTiebreaker(opts.deviceId),
      },
      leasedUntil: opts.leasedUntil,
    })
  }

  function selfOnlyLease() {
    // DEVICE_B intentionally absent → it's the pruned/unknown peer.
    return makeLease({
      deviceId: DEVICE_A,
      bee: bee as unknown as Bee,
      now: () => NOW,
      knownDeviceIds: () => [DEVICE_A],
      intentReadTimeoutMs: 50,
    })
  }

  it("yields when an earlier-generation occupancy beacon from a pruned peer is live", async () => {
    const lease = selfOnlyLease()
    expect(
      (await lease.acquire({ partitionCount: PARTITION_COUNT })).partition,
    ).toBe(0)

    // DEVICE_B holds p0 too with an EARLIER generation. Its occupancy beacon sits
    // in the PREVIOUS bucket — refresh()'s own beacon publish overwrites the
    // shared current-bucket occupancy SOC with DEVICE_A, so the previous-bucket
    // read is what surfaces the rival (the convergent interleaving the shared
    // address guarantees within a few ticks).
    await writeOccupancy({
      partition: 0,
      deviceId: DEVICE_B,
      epochBucket: intentEpochBucket(NOW) - 1,
      leasedUntil: NOW + LEASE_TTL_MS,
    })

    // foreignBeaconBeatsUs can't see DEVICE_B (not a known rival); only the
    // deviceId-independent occupancy channel catches it.
    expect(await lease.refresh()).toBe("displaced")
  })

  it("keeps the lease when the pruned peer's occupancy beacon is LATER-generation", async () => {
    const lease = selfOnlyLease()
    expect(
      (await lease.acquire({ partitionCount: PARTITION_COUNT })).partition,
    ).toBe(0)

    await writeOccupancy({
      partition: 0,
      deviceId: DEVICE_B,
      epochBucket: intentEpochBucket(NOW) - 1,
      leasedUntil: NOW + LEASE_TTL_MS,
      genTimestamp: NOW + 1000, // later than DEVICE_A's claim → we win
    })

    expect(await lease.refresh()).toBe("held")
  })

  it("keeps the lease when only our OWN occupancy beacon is present (no false displacement)", async () => {
    const lease = selfOnlyLease()
    expect(
      (await lease.acquire({ partitionCount: PARTITION_COUNT })).partition,
    ).toBe(0)
    // No foreign beacon written; acquire + refresh only publish DEVICE_A's own.
    expect(await lease.refresh()).toBe("held")
  })
})

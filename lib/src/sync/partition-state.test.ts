// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reserved-slot bucket-collision regression for `writePartitionState`.
 *
 * Every reserved-slot write for partition `p` lands at stamp index
 * `(bucket, slot=p)` on the shared batch: the counter chunks, the reference
 * chunk and the state-pointer entries. Two different chunks at the same
 * `(bucket, p)` make Bee's newer-stamp-wins replacement evict one of them. The
 * publish therefore must pick its randomly-keyed counter/reference chunks in
 * buckets distinct from the pointer entries a search depends on.
 *
 * The collision is a ~1/65536 random event in production, so these tests force
 * it deterministically by mocking the one randomness source
 * (`makeEncryptedContentAddressedChunk`): the first chunk the publish generates
 * is steered into a chosen reserved-slot bucket, and we assert the publish does
 * NOT place a chunk there (it must re-pick a clear bucket).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BatchId, PrivateKey, Reference } from "@ethersphere/bee-js"

// Steers the NEXT generated chunk address into `bucket` (consumed once), so a
// test can force a collision with a specific reserved-slot bucket. `vi.hoisted`
// makes it available to the hoisted `vi.mock` factory below.
const force = vi.hoisted(() => ({ bucket: undefined as number | undefined }))

/** A chunk address, the first half of an encrypted reference. */
const CHUNK_ADDRESS_BYTES = 32

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

// Wrap the real upload module so partition-state's own bindings resolve to these
// spies (default behaviour passes through to the real round-trip). A test can
// then fail a single chunk PUT and assert the pointer SOC never lands.
vi.mock("../proxy/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../proxy/upload")>()
  return {
    ...actual,
    uploadChunk: vi.fn(actual.uploadChunk),
    uploadSOC: vi.fn(actual.uploadSOC),
  }
})

import { writePartitionState } from "./partition-state"
import { uploadChunk, uploadSOC } from "../proxy/upload"
import { hexToUint8Array } from "../utils/hex"
import {
  NUM_BUCKETS,
  PARTITION_COUNT,
  toBucket,
  UtilizationAwareStamper,
} from "../utils/batch-utilization"
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

/** 200 buckets at 2: more than the exception list holds, so the counter
 *  packs into four leaves, the first real and the rest all-zero sentinels. */
function leafyCounter(extra: number[] = []): Uint32Array {
  const counter = new Uint32Array(NUM_BUCKETS)
  for (let b = 0; b < 200; b++) counter[b * 50] = 2
  for (const bucket of extra) counter[bucket] = 2
  return counter
}

/** Publish a counter with exactly one real leaf (one leaf PUT). */
async function publishOneChunk(
  stamper: UtilizationAwareStamper,
  nowMs: number,
): Promise<number[]> {
  const localCounter = leafyCounter()
  vi.spyOn(Date, "now").mockReturnValue(nowMs)
  const result = await writePartitionState({
    bee: bee,
    stamper,
    batchId: TEST_BATCH_ID,
    partition: PARTITION,
    localCounter,
    backupSigner: BACKUP_SIGNER,
    swarmEncryptionKey: TEST_ENC_KEY,
    seq: 1,
  })
  return result.stateBuckets
}

/** A store of its own, so a publish made only to learn an address leaves no trace. */
async function inScratchStore<T>(work: () => Promise<T>): Promise<T> {
  const kept = { store, bee }
  store = new MockChunkStore()
  bee = new MockBee(store)
  mockFetch(store, OWNER)
  try {
    return await work()
  } finally {
    store = kept.store
    bee = kept.bee
    mockFetch(store, OWNER)
  }
}

describe("writePartitionState — reserved-slot bucket-collision avoidance", () => {
  it("does not place a counter chunk in its own pointer entry's bucket", async () => {
    const now = 1_000_000_000_000
    // An entry's address depends only on its number: learn entry 1's bucket
    // from a publish elsewhere. `stateBuckets` ends with the pointer entries.
    const pointerBucket = await inScratchStore(async () =>
      (await publishOneChunk(await makeBoundStamper(), now)).at(-1),
    )
    force.bucket = pointerBucket // steer the first counter chunk onto the pointer
    const stateBuckets = await publishOneChunk(await makeBoundStamper(), now)

    // The pointer entry occupies (pointerBucket, slot=PARTITION); a counter/
    // reference chunk there would be evicted when the entry is written. The
    // publish must have re-picked a clear bucket: only the entry is there.
    expect(stateBuckets.filter((b) => b === pointerBucket)).toHaveLength(1)
    expect(new Set(stateBuckets).size).toBe(stateBuckets.length)
  })

  it("moves a retained chunk out of the bucket the next pointer entry is written to", async () => {
    const publish = (
      stamper: UtilizationAwareStamper,
      localCounter: Uint32Array,
      seq: number,
      previous?: Awaited<ReturnType<typeof writePartitionState>>,
    ) =>
      writePartitionState({
        bee: bee,
        stamper,
        batchId: TEST_BATCH_ID,
        partition: PARTITION,
        localCounter,
        backupSigner: BACKUP_SIGNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        seq,
        previousReferences: previous?.references,
        previousCounter: previous?.publishedCounter,
        previousFrame: previous?.frame,
      })
    // Leaf 0 and leaf 1 are real; the second publish changes leaf 1 only.
    const CHANGED_BUCKET = 20_000
    const counter = leafyCounter([CHANGED_BUCKET])

    const entryTwoBucket = await inScratchStore(async () =>
      (await publish(await makeBoundStamper(), counter, 2)).stateBuckets.at(-1),
    )

    // Entry 1's publish happens to put leaf 0 where entry 2 will go.
    const stamper = await makeBoundStamper()
    force.bucket = entryTwoBucket
    const first = await publish(stamper, counter, 1)
    expect(first.stateBuckets).toContain(entryTwoBucket)

    // Entry 2's publish changes only leaf 1. Leaf 0 is unchanged, but left
    // in place it would be replaced by the entry: it is uploaded again.
    const next = counter.slice()
    next[CHANGED_BUCKET] = 3
    const second = await publish(stamper, next, 2, first)

    expect(second.references[0]).not.toEqual(first.references[0])
    expect(
      second.stateBuckets.filter((b) => b === entryTwoBucket),
    ).toHaveLength(1)
    expect(new Set(second.stateBuckets).size).toBe(second.stateBuckets.length)
  })
})

describe("writePartitionState — the state it replaces", () => {
  // Until the new pointer entry is written, the previous state is the newest
  // there is: a publish that stops half-way must leave it readable.
  it("keeps its new chunks out of the buckets of the chunks it replaces", async () => {
    const publish = (
      stamper: UtilizationAwareStamper,
      localCounter: Uint32Array,
      seq: number,
      previous?: Awaited<ReturnType<typeof writePartitionState>>,
    ) =>
      writePartitionState({
        bee: bee,
        stamper,
        batchId: TEST_BATCH_ID,
        partition: PARTITION,
        localCounter,
        backupSigner: BACKUP_SIGNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        seq,
        previousReferences: previous?.references,
        previousCounter: previous?.publishedCounter,
        previousFrame: previous?.frame,
        previousReferenceHex: previous?.referenceHex,
      })
    const bucketOf = (reference: Uint8Array) =>
      toBucket(reference.slice(0, CHUNK_ADDRESS_BYTES))
    const stamper = await makeBoundStamper()
    const counter = leafyCounter()
    const first = await publish(stamper, counter, 1)
    const replaced = [
      bucketOf(hexToUint8Array(first.referenceHex)),
      bucketOf(first.references[0]),
    ]

    for (const bucket of replaced) {
      const next = counter.slice()
      next[0] += 1
      // Steer the changed leaf onto a chunk of the state being replaced.
      force.bucket = bucket
      const second = await publish(stamper, next, 2, first)
      expect(second.stateBuckets).not.toContain(bucket)
    }
  })
})

describe("writePartitionState — sparse sentinel refs are independent", () => {
  it("returns a distinct zero-ref instance per never-written leaf", async () => {
    const stamper = await makeBoundStamper()
    const localCounter = leafyCounter() // one real leaf → the rest are sentinels

    const { references } = await writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
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
    const localCounter = leafyCounter([20_000, 40_000, 60_000])

    const { stateBuckets } = await writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })

    // Every reserved-slot write lands at (bucket, slot=PARTITION); the parallel
    // publish is only race-free because those buckets are all distinct.
    expect(new Set(stateBuckets).size).toBe(stateBuckets.length)
  })
})

describe("writePartitionState — two-phase publish (pointer after chunks)", () => {
  it("does not write the state pointer when a chunk PUT fails", async () => {
    const stamper = await makeBoundStamper()
    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[1000] = 1

    // Fail the first counter-chunk PUT. The pointer must NOT land: a durable
    // pointer referencing chunks Bee never stored bricks every future takeover
    // (readFailed → read-only until batch expiry), since there is no
    // older-pointer fallback. See #414.
    vi.mocked(uploadChunk).mockRejectedValueOnce(new Error("chunk PUT failed"))
    vi.mocked(uploadSOC).mockClear()

    await expect(
      writePartitionState({
        bee: bee,
        stamper,
        batchId: TEST_BATCH_ID,
        partition: PARTITION,
        localCounter,
        backupSigner: BACKUP_SIGNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        seq: 1,
      }),
    ).rejects.toThrow()

    // Two-phase: the pointer SOC is written ONLY after every chunk PUT acks.
    expect(uploadSOC).not.toHaveBeenCalled()
  })
})

describe("writePartitionState — the pointer entry", () => {
  // The publish is the commit point: the next holder must be able to read the
  // entry the moment the upload is acknowledged. Bee defers a SOC that comes
  // with a tag unless told otherwise.
  it("is uploaded direct", async () => {
    const stamper = await makeBoundStamper()
    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[1000] = 1
    vi.mocked(uploadSOC).mockClear()

    await writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })

    expect(uploadSOC).toHaveBeenCalledTimes(1)
    expect(vi.mocked(uploadSOC).mock.calls[0][4]).toMatchObject({
      deferred: false,
    })
  })
})

describe("writePartitionState — counter monotonicity tripwire", () => {
  it("refuses an incremental publish whose counter regressed below the previous", async () => {
    const stamper = await makeBoundStamper()

    // A first full publish establishes the incremental baseline (refs + counter).
    const baseline = new Uint32Array(NUM_BUCKETS)
    baseline[1000] = 5
    const first = await writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      localCounter: baseline,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })

    // A regressed counter (bucket 1000 dropped 5 → 4) must fail loudly rather
    // than retain a ref describing a value ABOVE the live counter — the "impossible"
    // case the tripwire guards (a takeover would resume past an acked slot).
    const regressed = new Uint32Array(NUM_BUCKETS)
    regressed[1000] = 4
    await expect(
      writePartitionState({
        bee: bee,
        stamper,
        batchId: TEST_BATCH_ID,
        partition: PARTITION,
        localCounter: regressed,
        backupSigner: BACKUP_SIGNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        seq: 1,
        previousReferences: first.references,
        previousCounter: first.publishedCounter,
      }),
    ).rejects.toThrow(/counter regressed/)
  })

  it("refuses a full (sparse) publish whose counter regressed — no previousReferences", async () => {
    const stamper = await makeBoundStamper()

    const baseline = new Uint32Array(NUM_BUCKETS)
    baseline[1000] = 5
    const first = await writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      localCounter: baseline,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })

    // A previous counter is known but the ref set is NOT (the reachable
    // cache-hit-read case where the best-effort reference-chunk download failed),
    // so this is a FULL publish. The monotonicity tripwire must still fire — a
    // regressed counter is a broken-persistence symptom regardless of path.
    const regressed = new Uint32Array(NUM_BUCKETS)
    regressed[1000] = 4
    await expect(
      writePartitionState({
        bee: bee,
        stamper,
        batchId: TEST_BATCH_ID,
        partition: PARTITION,
        localCounter: regressed,
        backupSigner: BACKUP_SIGNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        seq: 1,
        // previousReferences intentionally omitted → full path.
        previousCounter: first.publishedCounter,
      }),
    ).rejects.toThrow(/counter regressed/)
  })
})

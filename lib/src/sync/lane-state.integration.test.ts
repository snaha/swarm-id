// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The published counter of a lane against an in-memory Swarm: the state
 * round trip (`partition-state.ts`) and a holder's resume and publish
 * (`lane-state.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BatchId, PrivateKey } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"

import { LaneState } from "./lane-state"
import * as partitionState from "./partition-state"
import * as downloadData from "../proxy/download-data"
import {
  NUM_BUCKETS,
  UtilizationAwareStamper,
} from "../utils/batch-utilization"
import type { UtilizationStoreDB } from "../storage/utilization-store"
import { leafCount } from "./counter-codec"
import { makeEncryptedContentAddressedChunk } from "../chunk"
import { uploadData, type UploadTarget } from "../proxy/upload"
import {
  MockBee,
  MockChunkStore,
  createTestSigner,
  createMockStamper,
  mockFetch,
} from "../proxy/feeds/epochs/test-utils"

const TEST_BATCH_ID = new BatchId("ab".repeat(32))
const TEST_ENC_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)
const BACKUP_SIGNER = createTestSigner() as PrivateKey
const OWNER = BACKUP_SIGNER.publicKey().address()

/**
 * A counter with more touched buckets than the exception list holds, so it
 * packs into leaves rather than exceptions alone: 200 buckets at 2 in the
 * first `LEAFY_BUCKETS_PER_LEAF` buckets, which the canonical frame
 * (`LEAFY_FRAME`) spreads over `LEAFY_LEAVES` leaves — the first real, the
 * rest all-zero sentinels. At 2, not 1: delta 1 fits width 1, whose two
 * leaves leave a single sentinel. `extra` puts more buckets at 2 wherever a
 * test wants another real leaf.
 */
const LEAFY_FRAME = { base: 0, width: 2 }
const LEAFY_LEAVES = 4
const LEAFY_BUCKETS_PER_LEAF = 16384
function leafyCounter(extra: number[] = []): Uint32Array {
  const counter = new Uint32Array(NUM_BUCKETS)
  for (let b = 0; b < 200; b++) counter[b * 50] = 2
  for (const bucket of extra) counter[bucket] = 2
  return counter
}

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
 * Publish a state pointer entry naming `referenceHex` — the test stand-in
 * for "a holder published this resume pointer". Used to seed
 * dangling / malformed pointers for the fail-safe read tests.
 */
async function seedStatePointer(
  referenceHex: string,
  partition = 0,
): Promise<void> {
  await partitionState.writeStatePointer({
    bee: bee,
    stamper: createMockStamper(),
    backupSigner: BACKUP_SIGNER,
    swarmEncryptionKey: TEST_ENC_KEY,
    batchId: TEST_BATCH_ID,
    partition,
    pointer: { seq: 1, referenceHex },
  })
}

function makeLaneState(): LaneState {
  return new LaneState({
    bee: bee,
    batchId: TEST_BATCH_ID,
    partition: 0,
    backupSigner: BACKUP_SIGNER,
    swarmEncryptionKey: TEST_ENC_KEY,
    stamper: createMockStamper(),
  })
}

/** Publish `counter` as entry 1 of partition 0, as an earlier holder would. */
async function publishAsEarlierHolder(counter: Uint32Array) {
  return partitionState.writePartitionState({
    bee: bee,
    stamper: createMockStamper(),
    batchId: TEST_BATCH_ID,
    partition: 0,
    localCounter: counter,
    backupSigner: BACKUP_SIGNER,
    swarmEncryptionKey: TEST_ENC_KEY,
    seq: 1,
  })
}

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

describe("readPartitionState / writePartitionState round-trip", () => {
  it("reads back the exact published counters", async () => {
    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[100] = 5
    localCounter[200] = 12

    const stamper = createMockStamper()
    await partitionState.writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })

    const result = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
    })

    expect(result.unchanged).toBe(false)
    // The reader reconstructs the exact published counter. No compensation: the
    // state pointer is a reserved-slot SOC, so it consumes no data slot.
    expect(result.localCounter).toEqual(localCounter)
  })

  it("reports the published state-chunk buckets identically on write and read", async () => {
    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[42] = 3
    const written = await partitionState.writePartitionState({
      bee: bee,
      stamper: createMockStamper(),
      batchId: TEST_BATCH_ID,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })

    // Sparse publish: one touched bucket packs as an exception at width 0, so
    // there is no leaf at all — only the reference chunk is uploaded, and the
    // pointer entry that names it.
    expect(written.frame).toEqual({ base: 0, width: 0 })
    expect(written.stateBuckets).toHaveLength(2)
    expect(new Set(written.stateBuckets).size).toBe(2)

    // A taking-over device derives the same protection set from the
    // reference chunk it downloads.
    const read = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
    })
    expect(new Set(read.stateBuckets)).toEqual(new Set(written.stateBuckets))
  })

  it("returns the per-leaf references (incl. sentinels) and the frame for the caller to seed", async () => {
    const localCounter = leafyCounter()
    const { referenceHex } = await partitionState.writePartitionState({
      bee: bee,
      stamper: createMockStamper(),
      batchId: TEST_BATCH_ID,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })

    // Full read: the complete ref set (one real ref + a sentinel for each
    // all-zero leaf) and the frame — exactly what a holder seeds as its
    // publish baseline so its first publish is incremental.
    const full = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
    })
    expect(full.frame).toEqual(LEAFY_FRAME)
    expect(leafCount(LEAFY_FRAME.width)).toBe(LEAFY_LEAVES)
    expect(full.references).toHaveLength(LEAFY_LEAVES)
    expect(full.references?.map((r) => r.some((b) => b !== 0))).toEqual([
      true,
      false,
      false,
      false,
    ])

    // Nothing newer than a state the caller already holds: nothing is
    // downloaded, so nothing is handed back to seed from.
    const unchanged = await partitionState.readPartitionState(
      {
        bee: bee,
        owner: OWNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        batchId: TEST_BATCH_ID,
        partition: 0,
      },
      { seq: 1, referenceHex },
    )
    expect(unchanged.unchanged).toBe(true)
    expect(unchanged.references).toBeUndefined()
  })

  it("skips the reference + counter-chunk downloads when the pointer is unchanged", async () => {
    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[100] = 5
    const stamper = createMockStamper()
    const { referenceHex: writtenRef } =
      await partitionState.writePartitionState({
        bee: bee,
        stamper,
        batchId: TEST_BATCH_ID,
        partition: 0,
        localCounter,
        backupSigner: BACKUP_SIGNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        seq: 1,
      })

    const getSpy = vi.spyOn(store, "get")

    // No cached reference → full download.
    const full = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
    })
    expect(full.unchanged).toBe(false)
    expect(full.localCounter).toEqual(localCounter)
    expect(full.referenceHex).toBe(writtenRef)
    const callsForFullRead = getSpy.mock.calls.length

    // Same reference cached → skip, reuse local counter, far fewer chunk reads.
    const cached = await partitionState.readPartitionState(
      {
        bee: bee,
        owner: OWNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        batchId: TEST_BATCH_ID,
        partition: 0,
      },
      { seq: 1, referenceHex: writtenRef },
    )
    expect(cached.unchanged).toBe(true)
    expect(cached.localCounter).toBeUndefined()
    expect(cached.referenceHex).toBe(writtenRef)
    const callsForCachedRead = getSpy.mock.calls.length - callsForFullRead
    expect(callsForCachedRead).toBeLessThan(callsForFullRead)
  })

  it("reports readFailed when the pointer's reference chunk is unreadable (no zero-seed)", async () => {
    // Publish a pointer entry that names a reference chunk which
    // resolves to nothing (evicted/corrupt). A pointer EXISTS, so the partition
    // has a real resume point we failed to learn — readPartitionState must NOT
    // zero-seed (that would re-issue every used slot); it reports readFailed.
    const danglingRef = Binary.uint8ArrayToHex(new Uint8Array(64).fill(0x99))
    await partitionState.writeStatePointer({
      bee: bee,
      stamper: createMockStamper(),
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      pointer: { seq: 1, referenceHex: danglingRef },
    })

    const result = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
    })

    expect(result.readFailed).toBe(true)
    expect(result.localCounter).toBeUndefined()
    expect(result.referenceHex).toBeUndefined()
  })

  it("reports readFailed when a single counter chunk is missing", async () => {
    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[100] = 5
    await partitionState.writePartitionState({
      bee: bee,
      stamper: createMockStamper(),
      batchId: TEST_BATCH_ID,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })

    // Learn a counter-chunk address by spying on a successful read: the read
    // path fetches the pointer SOC, then the reference chunk, then the counter
    // chunks in order — so the LAST fetched address is a counter chunk.
    const getSpy = vi.spyOn(store, "get")
    const ok = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
    })
    expect(ok.readFailed).toBeUndefined()
    const lastFetched = getSpy.mock.calls.at(-1)![0]
    expect(store.delete(lastFetched)).toBe(true)

    // One published chunk evicted/unreadable → the whole read fails safe.
    const result = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
    })
    expect(result.readFailed).toBe(true)
    expect(result.localCounter).toBeUndefined()
  })

  it("zero-seeds when nothing was ever published", async () => {
    const result = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
    })

    expect(result.readFailed).toBeUndefined()
    expect(result.unchanged).toBe(false)
    expect(result.localCounter![0]).toBe(0)
  })

  it("finds the newest of many published states, with or without a starting point", async () => {
    const LATEST = 70
    const referenceOf = (seq: number): string =>
      Binary.uint8ArrayToHex(new Uint8Array(64).fill(seq))
    const stamper = createMockStamper()
    for (let seq = 1; seq <= LATEST; seq++) {
      await partitionState.writeStatePointer({
        bee: bee,
        stamper,
        backupSigner: BACKUP_SIGNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        batchId: TEST_BATCH_ID,
        partition: 0,
        pointer: { seq, referenceHex: referenceOf(seq) },
      })
    }
    const lookup = (known?: partitionState.StatePointer) =>
      partitionState.readStatePointer({
        bee: bee,
        owner: OWNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        batchId: TEST_BATCH_ID,
        partition: 0,
        known,
      })
    const newest = {
      pointer: { seq: LATEST, referenceHex: referenceOf(LATEST) },
      inconclusive: false,
    }

    // From nothing, and from an older state this device once read.
    expect(await lookup()).toEqual(newest)
    expect(await lookup({ seq: 3, referenceHex: referenceOf(3) })).toEqual(
      newest,
    )
    // From the newest itself: nothing above it, so it is returned as is.
    expect(await lookup(newest.pointer)).toEqual(newest)
  })

  it("keeps the entries a search depends on clear of the chunks each publish writes", async () => {
    // Every publish of a long session, each one incremental against the last:
    // whatever stands in a pointer entry's bucket is moved before the entry
    // is written there. The newest state must stay readable from nothing.
    const PUBLISHES = 40
    const stamper = createMockStamper()
    const counter = new Uint32Array(NUM_BUCKETS)
    let previous:
      | Awaited<ReturnType<typeof partitionState.writePartitionState>>
      | undefined
    for (let seq = 1; seq <= PUBLISHES; seq++) {
      counter[seq] += 1
      previous = await partitionState.writePartitionState({
        bee: bee,
        stamper,
        batchId: TEST_BATCH_ID,
        partition: 0,
        localCounter: counter,
        backupSigner: BACKUP_SIGNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        seq,
        previousReferences: previous?.references,
        previousCounter: previous?.publishedCounter,
      })
      const buckets = previous.stateBuckets
      expect(new Set(buckets).size, `publish ${seq}`).toBe(buckets.length)
    }

    const read = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
    })
    expect(read.seq).toBe(PUBLISHES)
    expect(read.localCounter).toEqual(counter)
  })
})
/** Local byte-equality (the module's `bytesEqual` is not exported). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe("LaneState — a holder's resume and publish", () => {
  it("resumes the published counter, and its first publish is incremental (one leaf)", async () => {
    // An earlier holder published a counter with three real leaves.
    const published = leafyCounter([20_000, 40_000])
    await publishAsEarlierHolder(published)

    const writeSpy = vi.spyOn(partitionState, "writePartitionState")
    const state = makeLaneState()
    const resumed = await state.resume()
    expect(resumed).toEqual(published)

    // Advance exactly ONE bucket (in leaf 0), within the frame's width.
    const next = published.slice()
    next[100] = 3
    await state.publish(next)

    // The publish ran against the resumed state — it received the seeded ref
    // set, counter and frame (not undefined, which would force a re-publish of
    // all three real leaves), as the entry after the one it resumed from...
    expect(writeSpy).toHaveBeenCalledTimes(1)
    const args = writeSpy.mock.calls[0][0]
    expect(args.previousReferences).toHaveLength(LEAFY_LEAVES)
    expect(args.previousCounter).toEqual(published)
    expect(args.previousFrame).toEqual(LEAFY_FRAME)
    expect(args.seq).toBe(2)

    // ...and it re-uploaded only the changed leaf.
    const seed = args.previousReferences as Uint8Array[]
    const after = (await writeSpy.mock.results[0].value).references
    const changed = after
      .map((_: Uint8Array, i: number) => i)
      .filter((i: number) => !bytesEqual(after[i], seed[i]))
    expect(changed).toEqual([0])
  })

  // A leaf an incremental publish keeps goes out under an exception list
  // computed from the new counter. That only decodes when the publish is
  // diffed against exactly the counter the kept leaves encode — not against
  // a counter that ran ahead of it (stamps of an upload never acknowledged).
  it("publishes a state that decodes after it resumed a lane it had run ahead on", async () => {
    const state = makeLaneState()
    await state.resume()
    const acked = leafyCounter([20_000])
    await state.publish(acked)

    // The lane is taken again with nothing published since. The context's
    // own counter is ahead of the published one: far enough in one bucket to
    // need an exception under the kept frame.
    await state.resume()
    const ahead = acked.slice()
    ahead[100] = 50
    ahead[20_000] = 3
    await state.publish(ahead)

    const read = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
    })
    expect(read.readFailed).toBeUndefined()
    expect(read.localCounter).toEqual(ahead)
  })

  it("starts a lane nothing was published on from zero, at entry 1", async () => {
    const writeSpy = vi.spyOn(partitionState, "writePartitionState")
    const state = makeLaneState()
    expect(await state.resume()).toEqual(new Uint32Array(NUM_BUCKETS))

    const counter = new Uint32Array(NUM_BUCKETS)
    counter[100] = 1
    await state.publish(counter)

    expect(writeSpy.mock.calls[0][0].seq).toBe(1)
  })

  // Another context of this browser may have published a counter this one
  // never saw; the pointer the stamper keeps in shared storage says nothing
  // about THIS context's counter.
  it("reuses its own counter only against a state it read or wrote itself", async () => {
    const published = new Uint32Array(NUM_BUCKETS)
    published[100] = 5
    await publishAsEarlierHolder(published)
    const readSpy = vi.spyOn(partitionState, "readPartitionState")
    const state = makeLaneState()

    // First resume: nothing of its own to compare with, so the counter is read.
    expect(await state.resume()).toEqual(published)
    expect(readSpy.mock.calls[0][1]).toBeUndefined()

    // Resuming again with nothing published since: its own state is the
    // starting point, and the read reports it unchanged.
    await state.resume()
    expect(readSpy.mock.calls[1][1]).toMatchObject({ seq: 1 })
    expect((await readSpy.mock.results[1].value).unchanged).toBe(true)
  })

  // One stamper serves every lane a context takes, one after the other, and
  // keeps the counter of the one bound last.
  it("resumes a lane's own counter after the stamper was bound to another lane", async () => {
    const published = new Uint32Array(NUM_BUCKETS)
    published[100] = 5
    await publishAsEarlierHolder(published)
    const rows = new Map<string, unknown>()
    const stamper = await UtilizationAwareStamper.create(
      "11".repeat(32),
      TEST_BATCH_ID,
      20,
      {
        getAllChunks: async () => [],
        putChunk: async () => undefined,
        getMetadata: async (id: string) => rows.get(id),
        putMetadata: async (meta: { batchId: string }) => {
          rows.set(meta.batchId, meta)
        },
      } as unknown as UtilizationStoreDB,
      OWNER,
      TEST_ENC_KEY,
    )
    const state = new LaneState({
      bee: bee,
      batchId: TEST_BATCH_ID,
      partition: 0,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      stamper,
    })
    expect(await state.resume()).toEqual(published)

    const otherLane = new Uint32Array(NUM_BUCKETS)
    otherLane[100] = 1
    otherLane[200] = 9
    stamper.bindPartition({
      partition: 1,
      partitionCount: 2,
      localCounter: otherLane,
    })

    expect(await state.resume()).toEqual(published)
  })

  it("does not resume a lane whose published state cannot be read", async () => {
    // Partition 0's state pointer names an unreadable reference.
    await seedStatePointer(
      Binary.uint8ArrayToHex(new Uint8Array(64).fill(0x99)),
    )

    expect(await makeLaneState().resume()).toBeUndefined()
  })

  // A read that failed says nothing about the entry: a gateway answering 502,
  // a rate limit and a dropped connection all look like this.
  it("does not resume a published lane from zero while its pointer reads fail", async () => {
    const holder = makeLaneState()
    const counter = (await holder.resume()) ?? new Uint32Array(NUM_BUCKETS)
    counter[100] = 5
    await holder.publish(counter)

    vi.spyOn(downloadData, "downloadEncryptedSOC").mockRejectedValue(
      new TypeError("Failed to fetch"),
    )
    expect(await makeLaneState().resume()).toBeUndefined()
  })

  it("does not resume from an older entry when one read on the way to the newest fails", async () => {
    const holder = makeLaneState()
    const counter = (await holder.resume()) ?? new Uint32Array(NUM_BUCKETS)
    const published = 9
    for (let seq = 1; seq <= published; seq++) {
      counter[100] = seq
      await holder.publish(counter)
    }

    const download = downloadData.downloadEncryptedSOC
    let reads = 0
    vi.spyOn(downloadData, "downloadEncryptedSOC").mockImplementation(
      (...args) =>
        ++reads === 2
          ? Promise.reject(
              Object.assign(new Error("Bad Gateway"), { status: 502 }),
            )
          : download(...args),
    )
    expect(await makeLaneState().resume()).toBeUndefined()
  })

  // Bee answers 500 "read chunk failed" for a chunk nobody has when the node
  // asked is itself the closest to its address.
  it("starts from zero when the node asked is the closest to an entry nobody has", async () => {
    vi.spyOn(downloadData, "downloadEncryptedSOC").mockRejectedValue(
      Object.assign(new Error("Internal Server Error"), {
        status: 500,
        responseBody: { code: 500, message: "read chunk failed" },
      }),
    )
    expect(await makeLaneState().resume()).toEqual(new Uint32Array(NUM_BUCKETS))
  })

  it("after a publish fails, the next one looks before it writes and never reuses an entry", async () => {
    const state = makeLaneState()
    const counter = (await state.resume()) ?? new Uint32Array(NUM_BUCKETS)

    // The first publish writes entry 1, but the holder never learns it did:
    // the answer is lost.
    const publish = partitionState.writePartitionState
    const writeSpy = vi
      .spyOn(partitionState, "writePartitionState")
      .mockImplementationOnce(async (opts) => {
        await publish(opts)
        throw new Error("answer lost")
      })
    counter[100] = 1
    await expect(state.publish(counter)).rejects.toThrow("answer lost")

    counter[101] = 1
    await state.publish(counter)
    expect(writeSpy.mock.calls.map(([opts]) => opts.seq)).toEqual([1, 2])

    // And when the failed publish wrote nothing, its number is still free.
    writeSpy.mockRejectedValueOnce(new Error("nothing written"))
    counter[102] = 1
    await expect(state.publish(counter)).rejects.toThrow("nothing written")
    await state.publish(counter)
    expect(writeSpy.mock.calls.map(([opts]) => opts.seq)).toEqual([1, 2, 3, 3])
  })

  it("does not publish while it cannot tell which entry is the newest", async () => {
    const state = makeLaneState()
    const counter = (await state.resume()) ?? new Uint32Array(NUM_BUCKETS)
    const writeSpy = vi
      .spyOn(partitionState, "writePartitionState")
      .mockRejectedValueOnce(new Error("failed part-way"))
    await expect(state.publish(counter)).rejects.toThrow("failed part-way")

    vi.spyOn(partitionState, "readStatePointer").mockResolvedValue({
      pointer: undefined,
      inconclusive: true,
    })
    await expect(state.publish(counter)).rejects.toThrow(/newest/)
    expect(writeSpy).toHaveBeenCalledTimes(1)
  })
})

describe("readPartitionState — a state that cannot be read", () => {
  it("reports readFailed when the reference chunk has the wrong length", async () => {
    const target: UploadTarget = {
      mode: "stamper",
      bee: bee,
      stamper: createMockStamper(),
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

    const result = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
    })

    expect(result.readFailed).toBe(true)
    expect(result.localCounter).toBeUndefined()
    // The failed read must not be cached as "synced".
    expect(result.referenceHex).toBeUndefined()
  })

  it("reports readFailed when a leaf has the wrong length", async () => {
    const target: UploadTarget = {
      mode: "stamper",
      bee: bee,
      stamper: createMockStamper(),
    }

    // A well-formed reference chunk (width 1, base 0, no exceptions: two
    // leaves) whose entries both point at a leaf of the wrong length (100
    // bytes instead of a full chunk). The decoder must reject it and the read
    // must fail safe (readFailed, no zero-seed).
    const shortLeafRef = await uploadEncryptedBlob(
      target,
      new Uint8Array(100).fill(1),
    )
    const WIDTH_ONE_HEADER = new Uint8Array([1, 0, 0, 0, 0, 0, 0])
    const referenceChunk = Binary.concatBytes(
      WIDTH_ONE_HEADER,
      shortLeafRef,
      shortLeafRef,
    )
    const referenceChunkRef = await uploadEncryptedBlob(target, referenceChunk)
    await seedStatePointer(Binary.uint8ArrayToHex(referenceChunkRef))

    const result = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
    })

    expect(result.readFailed).toBe(true)
    expect(result.localCounter).toBeUndefined()
    expect(result.referenceHex).toBeUndefined()
  })

  it("fails safe (readFailed) when the pointer reads TIME OUT, even on a partition nothing was published on", async () => {
    // Force every state-pointer SOC read to hang so `withTimeout` classifies it
    // as an INCONCLUSIVE timeout (not a clean miss). A pointer may exist that
    // we just couldn't fetch — "no pointer found" must NOT zero-resume (that
    // would re-issue a gone holder's acked slots, evicting their data).
    // Degrade to read-only.
    const hang = vi
      .spyOn(downloadData, "downloadEncryptedSOC")
      .mockImplementation((() => new Promise(() => {})) as never)
    try {
      const result = await partitionState.readPartitionState({
        bee: bee,
        owner: OWNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        batchId: TEST_BATCH_ID,
        partition: 0,
      })
      expect(result.readFailed).toBe(true)
      expect(result.localCounter).toBeUndefined()
      expect(result.referenceHex).toBeUndefined()
    } finally {
      hang.mockRestore()
    }
  })

  it("fails safe when the read of an entry NEWER than the found pointer timed out (stale-pointer mask)", async () => {
    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[42] = 7
    await partitionState.writePartitionState({
      bee: bee,
      stamper: createMockStamper(),
      batchId: TEST_BATCH_ID,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })

    // Hang ONLY the read of entry 2. A later acked upload could have
    // published it — returning entry 1 as authoritative would resume BELOW
    // the acked high-water and re-issue acked slots (evicting data). The read
    // must fail safe (readFailed) instead of trusting the stale one.
    // The search from nothing reads the eleven powers of eight first, then
    // entries 2 to 7: entry 2 is the twelfth read.
    const ENTRY_TWO_READ = 12
    const download = downloadData.downloadEncryptedSOC
    let reads = 0
    const hang = vi
      .spyOn(downloadData, "downloadEncryptedSOC")
      .mockImplementation((...args) =>
        ++reads === ENTRY_TWO_READ ? new Promise(() => {}) : download(...args),
      )
    try {
      const result = await partitionState.readPartitionState({
        bee: bee,
        owner: OWNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        batchId: TEST_BATCH_ID,
        partition: 0,
      })
      expect(reads).toBeGreaterThanOrEqual(ENTRY_TWO_READ)
      expect(result.readFailed).toBe(true)
      expect(result.localCounter).toBeUndefined()
      expect(result.referenceHex).toBeUndefined()
    } finally {
      hang.mockRestore()
    }
  })

  it("fails safe on an inconclusive pointer read even when a local synced reference exists", async () => {
    // This device holds a synced pointer from an EARLIER session; a foreign
    // holder may have advanced the partition since (a peer's publish never
    // clears our local one). With ALL pointer reads timing out, "nothing
    // newer" is not authoritative — resuming `unchanged` from the stale local
    // pointer would re-issue the peer's acked slots. The fail-safe must win
    // over the same-device-reclaim shortcut.
    const hang = vi
      .spyOn(downloadData, "downloadEncryptedSOC")
      .mockImplementation((() => new Promise(() => {})) as never)
    try {
      const result = await partitionState.readPartitionState(
        {
          bee: bee,
          owner: OWNER,
          swarmEncryptionKey: TEST_ENC_KEY,
          batchId: TEST_BATCH_ID,
          partition: 0,
        },
        { seq: 3, referenceHex: "aa".repeat(64) }, // stale local synced pointer
      )
      expect(result.readFailed).toBe(true)
      expect(result.unchanged).toBe(false)
      expect(result.referenceHex).toBeUndefined()
    } finally {
      hang.mockRestore()
    }
  })

  it("resumes `unchanged` from the local synced pointer when a CLEAN search finds nothing newer", async () => {
    // Same-device reclaim: the synced entry is there, and every read of an
    // entry above it resolved cleanly absent (no timeouts), so "nothing
    // newer" is authoritative.
    const counter = new Uint32Array(NUM_BUCKETS)
    counter[7] = 1
    const { referenceHex } = await publishAsEarlierHolder(counter)
    const result = await partitionState.readPartitionState(
      {
        bee: bee,
        owner: OWNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        batchId: TEST_BATCH_ID,
        partition: 0,
      },
      { seq: 1, referenceHex },
    )
    expect(result.readFailed).toBeUndefined()
    expect(result.unchanged).toBe(true)
    expect(result.referenceHex).toBe(referenceHex)
  })

  // What a browser remembers can outlive what it describes: a format change
  // moves every entry to a new address, and a local chain can be reset. The
  // remembered entry is a place to start, and only if it is still there.
  it("does not resume from a remembered entry that is not there", async () => {
    const remembered = { seq: 3, referenceHex: "aa".repeat(64) }

    const lookup = await partitionState.readStatePointer({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      known: remembered,
    })
    expect(lookup).toEqual({ pointer: undefined, inconclusive: false })

    // And with a state published since: that one is found, from nothing.
    const counter = new Uint32Array(NUM_BUCKETS)
    counter[7] = 1
    const { referenceHex } = await publishAsEarlierHolder(counter)
    const result = await partitionState.readPartitionState(
      {
        bee: bee,
        owner: OWNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        batchId: TEST_BATCH_ID,
        partition: 0,
      },
      remembered,
    )
    expect(result.unchanged).toBe(false)
    expect(result.referenceHex).toBe(referenceHex)
    expect(result.localCounter).toEqual(counter)
  })

  it("is inconclusive when the remembered entry cannot be read", async () => {
    const counter = new Uint32Array(NUM_BUCKETS)
    counter[7] = 1
    const { referenceHex } = await publishAsEarlierHolder(counter)
    const hang = vi
      .spyOn(downloadData, "downloadEncryptedSOC")
      .mockImplementationOnce((() => new Promise(() => {})) as never)
    try {
      const lookup = await partitionState.readStatePointer({
        bee: bee,
        owner: OWNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        batchId: TEST_BATCH_ID,
        partition: 0,
        known: { seq: 1, referenceHex },
      })
      expect(lookup.inconclusive).toBe(true)
    } finally {
      hang.mockRestore()
    }
  })

  it("rejects publishing a counter with the wrong length", async () => {
    await expect(
      partitionState.writePartitionState({
        bee: bee,
        stamper: createMockStamper(),
        batchId: TEST_BATCH_ID,
        partition: 0,
        localCounter: new Uint32Array(5),
        backupSigner: BACKUP_SIGNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        seq: 1,
      }),
    ).rejects.toThrow(/65536/)
  })
})

describe("writePartitionState — incremental", () => {
  it("re-uploads only changed leaves (unchanged refs retained) and reads back the full counter", async () => {
    const stamper = createMockStamper()

    // Real leaves 0, 1 and 2; leaf 3 a sentinel.
    const counter = leafyCounter([20_000, 40_000])
    const first = await partitionState.writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      partition: 0,
      localCounter: counter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })
    expect(first.frame).toEqual(LEAFY_FRAME)
    expect(first.references).toHaveLength(LEAFY_LEAVES)

    // Change two buckets that fall in two distinct leaves, within the width
    // (3 = 2^2 − 1, the largest delta width 2 holds in-band).
    const next = first.publishedCounter.slice()
    next[100] = 3
    next[20_000] = 3
    const changed = new Set([
      Math.floor(100 / LEAFY_BUCKETS_PER_LEAF),
      Math.floor(20_000 / LEAFY_BUCKETS_PER_LEAF),
    ])
    expect(changed.size).toBe(2)

    const second = await partitionState.writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      partition: 0,
      localCounter: next,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 2,
      previousReferences: first.references,
      previousCounter: first.publishedCounter,
      previousFrame: first.frame,
    })
    expect(second.frame).toEqual(first.frame)

    // A re-uploaded leaf is re-keyed (fresh random key → new ref); an untouched
    // leaf keeps its prior ref, i.e. it was NOT re-uploaded. This is the
    // incremental guarantee — only the changed leaves hit the network.
    for (let i = 0; i < LEAFY_LEAVES; i++) {
      const retained =
        Binary.uint8ArrayToHex(second.references[i]) ===
        Binary.uint8ArrayToHex(first.references[i])
      expect(retained, `leaf ${i} retained?`).toBe(!changed.has(i))
    }

    // The taking-over device still reconstructs the FULL counter (changed +
    // retained).
    const read = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
    })
    expect(read.localCounter).toEqual(next)
  })

  it("does a full publish when no previous refs are supplied", async () => {
    const counter = leafyCounter()
    // previousCounter without previousReferences → NOT incremental.
    const res = await partitionState.writePartitionState({
      bee: bee,
      stamper: createMockStamper(),
      batchId: TEST_BATCH_ID,
      partition: 0,
      localCounter: counter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
      previousCounter: counter.slice(),
    })
    expect(res.references).toHaveLength(LEAFY_LEAVES)
    expect(res.references.every((r) => r.length === 64)).toBe(true)
  })

  it("packs a publish into fewer chunks than the counter has rows of buckets", async () => {
    // What a 10 MB upload does to a lane: a stamp or two in a few thousand
    // buckets spread over the whole table.
    const counter = new Uint32Array(NUM_BUCKETS)
    for (let i = 0; i < 2560; i++) counter[(i * 25) % NUM_BUCKETS] += 1

    const { references, frame } = await partitionState.writePartitionState({
      bee: bee,
      stamper: createMockStamper(),
      batchId: TEST_BATCH_ID,
      partition: 0,
      localCounter: counter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })

    expect(frame.width).toBe(1)
    expect(references).toHaveLength(2)
  })
})

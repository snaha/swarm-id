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
import { NUM_BUCKETS, getChunkLayout } from "../utils/batch-utilization"
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
const TEST_BATCH_DEPTH = 24
const TEST_ENC_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)
const BACKUP_SIGNER = createTestSigner() as PrivateKey
const OWNER = BACKUP_SIGNER.publicKey().address()

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
    batchDepth: TEST_BATCH_DEPTH,
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
    batchDepth: TEST_BATCH_DEPTH,
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
      batchDepth: TEST_BATCH_DEPTH,
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
      batchDepth: TEST_BATCH_DEPTH,
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
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })

    // Sparse publish: only the ONE non-zero counter chunk (bucket 42's chunk)
    // is uploaded, plus the reference chunk — far fewer than
    // numUtilizationChunks (the all-zero chunks are sentinels, never uploaded).
    // All distinct.
    const { numUtilizationChunks } = getChunkLayout(TEST_BATCH_DEPTH)
    // 1 non-zero counter chunk + ref chunk + the pointer entry
    expect(written.stateBuckets).toHaveLength(3)
    expect(written.stateBuckets.length).toBeLessThan(numUtilizationChunks)
    expect(new Set(written.stateBuckets).size).toBe(3)

    // A taking-over device derives the same protection set from the
    // reference chunk it downloads.
    const read = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(new Set(read.stateBuckets)).toEqual(new Set(written.stateBuckets))
  })

  it("returns the per-chunk references (incl. sentinels) for the caller to seed", async () => {
    const { numUtilizationChunks } = getChunkLayout(TEST_BATCH_DEPTH)

    const localCounter = new Uint32Array(NUM_BUCKETS)
    localCounter[100] = 5 // chunk 0
    const stamper = createMockStamper()
    const { referenceHex } = await partitionState.writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })

    // Full read: the complete ref set (one real ref + sentinels for the rest),
    // length numUtilizationChunks — exactly what claimPartition seeds as the
    // publish baseline so the first publish is incremental.
    const full = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(full.references).toHaveLength(numUtilizationChunks)

    // Cache hit still returns references (best-effort ref-chunk download), so a
    // reload's re-acquire can seed an incremental first publish too.
    const cached = await partitionState.readPartitionState(
      {
        bee: bee,
        owner: OWNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        batchId: TEST_BATCH_ID,
        partition: 0,
        batchDepth: TEST_BATCH_DEPTH,
      },
      { seq: 1, referenceHex },
    )
    expect(cached.unchanged).toBe(true)
    expect(cached.references).toHaveLength(numUtilizationChunks)
    expect(cached.references).toEqual(full.references)
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
        batchDepth: TEST_BATCH_DEPTH,
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
      batchDepth: TEST_BATCH_DEPTH,
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
        batchDepth: TEST_BATCH_DEPTH,
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
      batchDepth: TEST_BATCH_DEPTH,
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
      batchDepth: TEST_BATCH_DEPTH,
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
      batchDepth: TEST_BATCH_DEPTH,
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
      batchDepth: TEST_BATCH_DEPTH,
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
      batchDepth: TEST_BATCH_DEPTH,
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
        batchDepth: TEST_BATCH_DEPTH,
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
      batchDepth: TEST_BATCH_DEPTH,
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
  it("resumes the published counter, and its first publish is incremental (one chunk)", async () => {
    const { numUtilizationChunks } = getChunkLayout(TEST_BATCH_DEPTH)
    // An earlier holder published multi-chunk state (non-zero buckets across
    // three distinct counter chunks; bucketsPerChunk = 2048).
    const published = new Uint32Array(NUM_BUCKETS)
    published[100] = 5 // chunk 0
    published[3000] = 7 // chunk 1
    published[5000] = 9 // chunk 2
    await publishAsEarlierHolder(published)

    const writeSpy = vi.spyOn(partitionState, "writePartitionState")
    const state = makeLaneState()
    const resumed = await state.resume()
    expect(resumed).toEqual(published)

    // Advance exactly ONE bucket (same chunk 0) and publish.
    const next = published.slice()
    next[101] += 1
    await state.publish(next)

    // The publish ran against the resumed state — it received the full seeded
    // ref set as `previousReferences` (not undefined, which would force a
    // re-publish of all three non-zero chunks), as the entry after the one it
    // resumed from...
    expect(writeSpy).toHaveBeenCalledTimes(1)
    const args = writeSpy.mock.calls[0][0]
    expect(args.previousReferences).toHaveLength(numUtilizationChunks)
    expect(args.previousCounter).toEqual(published)
    expect(args.seq).toBe(2)

    // ...and it re-uploaded only the changed chunk.
    const seed = args.previousReferences as Uint8Array[]
    const after = (await writeSpy.mock.results[0].value).references
    const changed = after
      .map((_: Uint8Array, i: number) => i)
      .filter((i: number) => !bytesEqual(after[i], seed[i]))
    expect(changed).toEqual([0])
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

  it("does not resume a lane whose published state cannot be read", async () => {
    // Partition 0's state pointer names an unreadable reference.
    await seedStatePointer(
      Binary.uint8ArrayToHex(new Uint8Array(64).fill(0x99)),
    )

    expect(await makeLaneState().resume()).toBeUndefined()
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
      batchDepth: TEST_BATCH_DEPTH,
    })

    expect(result.readFailed).toBe(true)
    expect(result.localCounter).toBeUndefined()
    // The failed read must not be cached as "synced".
    expect(result.referenceHex).toBeUndefined()
  })

  it("reports readFailed when a counter chunk has the wrong length", async () => {
    const target: UploadTarget = {
      mode: "stamper",
      bee: bee,
      stamper: createMockStamper(),
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

    const result = await partitionState.readPartitionState({
      bee: bee,
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
        batchDepth: TEST_BATCH_DEPTH,
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
      batchDepth: TEST_BATCH_DEPTH,
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
        batchDepth: TEST_BATCH_DEPTH,
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
          batchDepth: TEST_BATCH_DEPTH,
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
    // Same-device reclaim: every read of an entry above the synced one
    // resolved cleanly absent (no timeouts), so "nothing newer" is
    // authoritative and the local synced pointer stays trustworthy.
    const knownRef = "aa".repeat(64)
    const result = await partitionState.readPartitionState(
      {
        bee: bee,
        owner: OWNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        batchId: TEST_BATCH_ID,
        partition: 0,
        batchDepth: TEST_BATCH_DEPTH,
      },
      { seq: 3, referenceHex: knownRef },
    )
    expect(result.readFailed).toBeUndefined()
    expect(result.unchanged).toBe(true)
    expect(result.referenceHex).toBe(knownRef)
  })

  it("rejects publishing a counter with the wrong length", async () => {
    await expect(
      partitionState.writePartitionState({
        bee: bee,
        stamper: createMockStamper(),
        batchId: TEST_BATCH_ID,
        batchDepth: TEST_BATCH_DEPTH,
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
  it("re-uploads only changed chunks (unchanged refs retained) and reads back the full counter", async () => {
    const stamper = createMockStamper()
    const { numUtilizationChunks, bucketsPerChunk } =
      getChunkLayout(TEST_BATCH_DEPTH)

    const counter = new Uint32Array(NUM_BUCKETS)
    counter[100] = 5
    const first = await partitionState.writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter: counter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
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

    const second = await partitionState.writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter: next,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 2,
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
    const read = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(read.localCounter).toEqual(next)
  })

  it("does a full publish when no previous refs are supplied", async () => {
    const stamper = createMockStamper()
    const { numUtilizationChunks } = getChunkLayout(TEST_BATCH_DEPTH)
    const counter = new Uint32Array(NUM_BUCKETS)
    counter[1] = 1
    // previousCounter without previousReferences → NOT incremental.
    const res = await partitionState.writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter: counter,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
      previousCounter: counter.slice(),
    })
    expect(res.references).toHaveLength(numUtilizationChunks)
    expect(res.references.every((r) => r.length === 64)).toBe(true)
  })

  // Regression: the "divergent seed" the cache-hit branch of `claimPartition`
  // produces after a FAILED publish — `previousReferences` describe the last
  // ACKED counter, but `previousCounter` (= the stamper's local counter) is
  // AHEAD by an unacked write. The incremental diff must retain the acked ref
  // for the ahead-but-unchanged chunk, so a takeover resumes at the acked FLOOR
  // (never past it into an acked slot). See the SAFETY INVARIANT note in
  // partition-lease.ts (`claimPartition`).
  it("retains the acked ref when the seed counter is ahead (unacked write); reader resumes at the acked floor", async () => {
    const stamper = createMockStamper()
    const { bucketsPerChunk } = getChunkLayout(TEST_BATCH_DEPTH)

    // 1. The last ACKED publish: bucket 100 at counter 5.
    const AHEAD_BUCKET = 100
    const NEW_BUCKET = 5000
    const ACKED_VALUE = 5
    const acked = new Uint32Array(NUM_BUCKETS)
    acked[AHEAD_BUCKET] = ACKED_VALUE
    const ackedPublish = await partitionState.writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter: acked,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 1,
    })

    // 2. Seed as claimPartition's cache-hit branch would AFTER a failed publish:
    //    refs describe the acked counter (100 -> 5) but the baseline counter is
    //    AHEAD (100 -> 6), the unacked write that never reached Swarm.
    const seededCounter = ackedPublish.publishedCounter.slice()
    seededCounter[AHEAD_BUCKET] = ACKED_VALUE + 1 // 6, unacked

    // 3. First incremental publish: a NEW upload touches a DIFFERENT bucket, so
    //    the chunk holding AHEAD_BUCKET is unchanged vs the ahead baseline and
    //    its ref is retained (the acked-floor ref, describing 5 — not 6).
    const current = seededCounter.slice()
    current[NEW_BUCKET] = 1
    const aheadChunk = Math.floor(AHEAD_BUCKET / bucketsPerChunk)
    const newChunk = Math.floor(NEW_BUCKET / bucketsPerChunk)
    expect(aheadChunk).not.toBe(newChunk)

    const incremental = await partitionState.writePartitionState({
      bee: bee,
      stamper,
      batchId: TEST_BATCH_ID,
      batchDepth: TEST_BATCH_DEPTH,
      partition: 0,
      localCounter: current,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      seq: 2,
      previousReferences: ackedPublish.references,
      previousCounter: seededCounter,
    })

    // The ahead chunk kept the ACKED ref (not re-uploaded); the new chunk changed.
    expect(
      Binary.uint8ArrayToHex(incremental.references[aheadChunk]),
      "ahead chunk ref retained (acked floor)",
    ).toBe(Binary.uint8ArrayToHex(ackedPublish.references[aheadChunk]))
    expect(
      Binary.uint8ArrayToHex(incremental.references[newChunk]),
      "new chunk re-uploaded",
    ).not.toBe(Binary.uint8ArrayToHex(ackedPublish.references[newChunk]))

    // A takeover reconstructs the ACKED floor for the ahead bucket (5), never the
    // unacked 6 — so it reissues only the unacked slot, never an acked one.
    const read = await partitionState.readPartitionState({
      bee: bee,
      owner: OWNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: 0,
      batchDepth: TEST_BATCH_DEPTH,
    })
    expect(read.localCounter?.[AHEAD_BUCKET]).toBe(ACKED_VALUE)
    expect(read.localCounter?.[NEW_BUCKET]).toBe(1)
  })
})

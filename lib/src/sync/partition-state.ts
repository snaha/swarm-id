// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Partition-state pointer for multi-device postage-batch sharing.
 *
 * The current holder publishes its per-partition counter on each upload (and on
 * release); the next holder reads it on acquire and resumes from exactly that
 * counter, so the two devices never race for the same `(bucket, slot)` pair
 * during an orderly hand-off.
 *
 * The counter is not a single blob: it is split into the same per-`chunkIndex`
 * chunks the utilisation store uses, each uploaded with a random key to the
 * partition's reserved slot (never a data slot), and a single "reference chunk"
 * lists their 64-byte encrypted references (address‖key).
 *
 * The address of the latest reference chunk is published as a numbered,
 * write-once **state-pointer entry** (`readStatePointer`): publish 1, 2, 3, …
 * each write an encrypted SOC at an address computed from the number, and a
 * reader searches for the highest number written
 * (`state-pointer-search.ts`). No address is ever written twice, so a reader
 * is never served an older version of one, and the lookup needs no clock. See
 * docs/Postage-Batch-Partitioning.md (§8 cross-device handoff).
 *
 * Topic = keccak256("swarm-id-partition-state-v1" ‖ batchId ‖ uint32(partition))
 * Owner = backup signer (`deriveSecret(swarmEncryptionKey, BACKUP_KEY_LABEL)`)
 */

import {
  Bee,
  BatchId,
  EthAddress,
  Identifier,
  PrivateKey,
  Reference,
  Topic,
  type Stamper,
} from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { makeSOCAddress } from "@ethersphere/core-sdk"
import { z } from "zod"
import {
  downloadDataWithChunkAPI,
  downloadEncryptedSOC,
} from "../proxy/download-data"
import { uploadChunk, uploadSOC, type UploadTarget } from "../proxy/upload"
import { TimeoutError, withTimeout } from "../utils/promise"
import { makeEncryptedContentAddressedChunk } from "../chunk"
import {
  NUM_BUCKETS,
  UtilizationAwareStamper,
  extractChunk,
  getChunkLayout,
  mergeChunk,
  toBucket,
} from "../utils/batch-utilization"
import { lockSocBucket } from "../utils/lock-soc"
import {
  intentEpochBucket,
  intentSocAddress,
  partitionOccupancyAddress,
} from "./partition-intent"
import {
  entrySalt,
  findLatestSeq,
  searchPath,
  type Probe,
} from "./state-pointer-search"
import { SYNC_READ_TIMEOUT_MS } from "./timing-constants"

/** Length of a Swarm encrypted reference: 32-byte address + 32-byte key. */
const ENCRYPTED_REFERENCE_BYTES = 64

/**
 * All-zero reference sentinel for a counter chunk that is entirely zero (never
 * written). It is NOT uploaded — the reference chunk just carries the sentinel
 * at that index, and the reader defaults a sentinel to a zero chunk. Keeps the
 * first publish sparse (only the touched chunks) instead of writing all
 * `numUtilizationChunks`, most of which are zero. Safe sentinel: a real ref is
 * `keccak256-address ‖ random-key`, never all-zero.
 */
const ZERO_CHUNK_REF = new Uint8Array(ENCRYPTED_REFERENCE_BYTES)

/** Domain-separation tag for partition-state-feed topics. */
const PARTITION_STATE_TOPIC_DOMAIN = "swarm-id-partition-state-v1"

/** Bytes to encode `partition` as big-endian uint32. */
const UINT32_BYTES = 4

/**
 * Schema for the *decoded* partition state: the per-bucket counter
 * reconstructed from the binary wire format (reference chunk → counter
 * chunks, see the module doc above for the byte layout). The wire format is
 * versioned by the feed topic domain (`PARTITION_STATE_TOPIC_DOMAIN`), not an
 * in-blob version byte — a future v2 publishes under a v2 topic and never
 * collides with v1 readers.
 *
 * `readPartitionState` validates the assembled counter against this schema
 * before returning it; a failure is reported as `readFailed` (fail-safe —
 * never a zero counter, which would re-issue used slots).
 * `writePartitionState` validates its input against it before publishing.
 */
export const PartitionStateSchemaV1 = z.object({
  counters: z.instanceof(Uint32Array).refine((c) => c.length === NUM_BUCKETS, {
    message: `counters must have ${NUM_BUCKETS} entries`,
  }),
})

export type PartitionState = z.infer<typeof PartitionStateSchemaV1>

/**
 * Build the per-partition state feed topic.
 *
 * Hashing rather than concatenating-to-string keeps the topic length
 * fixed at 32 bytes regardless of how many partitions we support later.
 */
export function makePartitionStateTopic(
  batchId: BatchId,
  partition: number,
): Topic {
  const partitionBytes = new Uint8Array(UINT32_BYTES)
  new DataView(partitionBytes.buffer).setUint32(0, partition, false)
  const hash = Binary.keccak256(
    Binary.concatBytes(
      new TextEncoder().encode(PARTITION_STATE_TOPIC_DOMAIN),
      batchId.toUint8Array(),
      partitionBytes,
    ),
  )
  return new Topic(hash)
}

/** Bound a single pointer read so an absent SOC doesn't block on peer exhaustion. */
const STATE_POINTER_READ_TIMEOUT_MS = SYNC_READ_TIMEOUT_MS

/** A published state: its place in the sequence and its reference chunk. */
export interface StatePointer {
  seq: number
  referenceHex: string
}

/** Result of a `readStatePointer` lookup (see its doc for `inconclusive`). */
export interface StatePointerLookup {
  /** The newest entry; undefined when nothing was ever published. */
  pointer?: StatePointer
  inconclusive: boolean
}

/**
 * A state-pointer entry: the reference of the published reference chunk
 * (address‖key) and the entry's own number, which is what proves to a reader
 * that the chunk at entry N's address is entry N.
 */
const StatePointerPayloadSchemaV1 = z.object({
  referenceHex: z.string(),
  seq: z.number().int().positive(),
})

const UINT64_BYTES = 8

/**
 * Where a partition's state-pointer entries live. Entry `seq` is the SOC with
 * identifier `keccak256(topic ‖ uint64(seq) ‖ uint8(salt))`, the salt chosen
 * by `entrySalt` so the entries a search depends on never share a bucket.
 * Addresses are memoised: one lookup or publish asks for the same few many
 * times over.
 */
function statePointerEntries(
  batchId: BatchId,
  partition: number,
  owner: EthAddress,
) {
  const topic = makePartitionStateTopic(batchId, partition)
  const identifierOf = (seq: number, salt: number): Identifier => {
    const tail = new Uint8Array(UINT64_BYTES + 1)
    const view = new DataView(tail.buffer)
    view.setBigUint64(0, BigInt(seq), false)
    view.setUint8(UINT64_BYTES, salt)
    return new Identifier(
      Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), tail)),
    )
  }
  const buckets = new Map<string, number>()
  const bucketOf = (seq: number, salt: number): number => {
    const key = `${seq}:${salt}`
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = toBucket(
        makeSOCAddress(identifierOf(seq, salt), owner).toUint8Array(),
      )
      buckets.set(key, bucket)
    }
    return bucket
  }
  const salts = new Map<number, number>()
  const saltOf = (seq: number): number => {
    let salt = salts.get(seq)
    if (salt === undefined) {
      salt = entrySalt(seq, bucketOf)
      salts.set(seq, salt)
    }
    return salt
  }
  return {
    identifier: (seq: number): Identifier => identifierOf(seq, saltOf(seq)),
    bucket: (seq: number): number => bucketOf(seq, saltOf(seq)),
  }
}

/**
 * The buckets of the pointer entries a search depends on once entry `seq` is
 * the newest (`searchPath`), `seq` itself included. Nothing else written to
 * the partition's reserved slot may land in them.
 */
function statePointerPathBuckets(
  batchId: BatchId,
  partition: number,
  owner: EthAddress,
  seq: number,
): number[] {
  const entries = statePointerEntries(batchId, partition, owner)
  return searchPath(seq).map((entry) => entries.bucket(entry))
}

/**
 * Publish entry `seq` of the partition's state pointer — a reserved-slot,
 * encrypted SOC, so it never consumes a data slot. The caller has made the
 * reference chunk it names durable first.
 */
export async function writeStatePointer(opts: {
  bee: Bee
  stamper: Stamper
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  batchId: BatchId
  partition: number
  pointer: StatePointer
}): Promise<void> {
  const owner = opts.backupSigner.publicKey().address()
  const identifier = statePointerEntries(
    opts.batchId,
    opts.partition,
    owner,
  ).identifier(opts.pointer.seq)
  const address = makeSOCAddress(identifier, owner).toUint8Array()
  const data = new TextEncoder().encode(JSON.stringify(opts.pointer))
  const target: UploadTarget = {
    mode: "stamper",
    bee: opts.bee,
    stamper: opts.stamper,
  }
  if (opts.stamper instanceof UtilizationAwareStamper) {
    // Serialized against concurrent intent/occupancy SOC writes (the off-lock
    // refresh-tick beacon vs. this under-lock publish) so neither clobbers the
    // shared intent-SOC reservation and mis-stamps into a data slot.
    await opts.stamper.withIntentSocSlot(address, opts.partition, () =>
      uploadSOC(target, opts.backupSigner, identifier, data, {
        encryptionKey: opts.swarmEncryptionKey,
      }),
    )
    return
  }
  await uploadSOC(target, opts.backupSigner, identifier, data, {
    encryptionKey: opts.swarmEncryptionKey,
  })
}

/**
 * Find the newest state-pointer entry by search (`findLatestSeq`): each round
 * reads a handful of entry addresses in parallel.
 *
 * Pass `known`, an entry this device knows was written (its own last publish,
 * or the state it last read): when nothing newer exists the lookup is one
 * round and returns `known` itself. The hint only saves reads; the answer is
 * the one a search from nothing would give.
 *
 * `inconclusive` marks an answer that is NOT authoritative: a read that could
 * have shown a newer entry timed out, so a later publish may be hidden behind
 * it. The caller must fail safe rather than resume from what was found.
 */
export async function readStatePointer(opts: {
  bee: Bee
  owner: EthAddress
  swarmEncryptionKey: Uint8Array
  batchId: BatchId
  partition: number
  known?: StatePointer
}): Promise<StatePointerLookup> {
  const entries = statePointerEntries(opts.batchId, opts.partition, opts.owner)
  const references = new Map<number, string>()
  const readEntry = async (seq: number): Promise<Probe> => {
    try {
      const soc = await withTimeout(
        downloadEncryptedSOC(
          opts.bee,
          opts.owner,
          entries.identifier(seq),
          opts.swarmEncryptionKey,
        ),
        STATE_POINTER_READ_TIMEOUT_MS,
        "state-pointer read timed out",
      )
      const parsed = StatePointerPayloadSchemaV1.safeParse(
        JSON.parse(new TextDecoder().decode(soc.payload)),
      )
      if (!parsed.success || parsed.data.seq !== seq) return false
      references.set(seq, parsed.data.referenceHex)
      return true
    } catch (error) {
      // A timeout leaves the entry unsettled (a slow gateway may hold it); a
      // clean miss or a malformed blob is a conclusive absent.
      return error instanceof TimeoutError ? undefined : false
    }
  }
  const { seq, inconclusive } = await findLatestSeq({
    known: opts.known?.seq ?? 0,
    read: (seqs) => Promise.all(seqs.map(readEntry)),
  })
  const referenceHex =
    seq === opts.known?.seq ? opts.known.referenceHex : references.get(seq)
  return {
    pointer: referenceHex === undefined ? undefined : { seq, referenceHex },
    inconclusive,
  }
}

/**
 * Read the latest published partition state and reconstruct the
 * `localCounter` array — the previous holder's per-bucket high-water.
 *
 * Returns a fresh zero-filled array when no prior snapshot exists — i.e.
 * when a fresh partition is being seeded for the first time (Case A on a
 * brand-new account, or Case B when no peer has yet published on the
 * partition we're about to take). We resume at exactly the published
 * counter: an unclean-crash window where a peer stamped past its last
 * publish is not defended against — that data was never durably persisted
 * anyway, so overwriting those slots loses nothing of value.
 *
 * Pass `known` (the published state this device's local counter was last in
 * sync with) to short-circuit: when nothing newer was published, returns
 * `{ unchanged: true }` WITHOUT downloading the counter chunks, and the
 * caller reuses its local counter. On a real read it returns the
 * reconstructed `localCounter` plus the current `referenceHex` and `seq` for
 * the caller to cache.
 */
export async function readPartitionState(
  opts: {
    bee: Bee
    owner: EthAddress
    swarmEncryptionKey: Uint8Array
    batchId: BatchId
    partition: number
    batchDepth: number
    /**
     * A `readStatePointer` result the caller already fetched (speculatively,
     * overlapped with its lock/beacon scan) for this SAME
     * (owner, batch, partition) and the SAME `known`. When provided, the
     * pointer lookup is skipped.
     */
    prefetchedPointer?: StatePointerLookup
  },
  known?: StatePointer,
): Promise<{
  localCounter?: Uint32Array
  referenceHex?: string
  /** The entry the state was read from; undefined when nothing was published. */
  seq?: number
  unchanged: boolean
  /**
   * True when the partition may have a published state that could not be
   * read: a pointer read that did not settle, or a pointer whose reference
   * chunk or counter chunk could not be read. The caller must NOT proceed
   * with a zero counter — stamping from zero would re-issue every used slot
   * (each overstamp evicts the existing data chunk from the reserve).
   * Degrade to read-only and retry instead.
   */
  readFailed?: boolean
  /**
   * Buckets occupied by the published state of the entry that was read: its
   * counter chunks, its reference chunk, and the pointer entries a search
   * for it depends on. The caller hands these to the stamper so utilisation
   * saves avoid overstamping (and evicting) the published resume point.
   * Present only on a successful full read.
   */
  stateBuckets?: number[]
  /**
   * The N per-chunk refs (sentinels included) the resume state was assembled
   * from — i.e. the reference chunk's contents. The caller seeds these as the
   * lease's `publishedReferences` so its FIRST publish is incremental against
   * the resumed state (only the changed chunk + reference chunk), not a full
   * re-publish. Present on a full read and (best-effort) on a cache hit;
   * undefined when no prior state exists.
   */
  references?: Uint8Array[]
}> {
  const { bee, owner, swarmEncryptionKey, batchId, partition, batchDepth } =
    opts

  const { pointer, inconclusive } =
    opts.prefetchedPointer ??
    (await readStatePointer({
      bee,
      owner,
      swarmEncryptionKey,
      batchId,
      partition,
      known,
    }))

  // A pointer read that could have shown a newer entry did not settle, so
  // what was found (or that nothing was) is not the resume point for sure.
  // Resuming from it would re-issue the slots a later publish acked. Fail
  // safe: read-only and retry.
  if (inconclusive) {
    console.warn(
      `[partition-state] partition ${partition}: a state-pointer read timed ` +
        "out (a newer resume point may be hidden); degrading to read-only " +
        "instead of resuming.",
    )
    return { unchanged: false, readFailed: true }
  }

  // Nothing was ever published: a fresh partition, seeded from zero.
  if (!pointer) {
    return { localCounter: new Uint32Array(NUM_BUCKETS), unchanged: false }
  }

  const { referenceHex, seq } = pointer
  const refBytes = new Reference(referenceHex).toUint8Array()

  // Cache hit: nothing newer than the state this device's local counter is
  // already in sync with. Skip the COUNTER-chunk downloads — but still fetch
  // the single reference chunk so we can return its per-chunk refs, letting the
  // caller's FIRST publish be incremental against the resumed state rather than a
  // full re-publish. Best-effort: on failure omit `references` (the first publish
  // then falls back to the sparse-full path).
  if (known !== undefined && seq === known.seq) {
    const { numUtilizationChunks } = getChunkLayout(batchDepth)
    const references = await downloadReferenceChunkRefs(
      bee,
      refBytes,
      numUtilizationChunks,
    ).catch(() => undefined)
    return { referenceHex, seq, unchanged: true, references }
  }

  const localCounter = new Uint32Array(NUM_BUCKETS)
  // The reference chunk and every counter chunk overstamp this partition's
  // reserved slot in their respective buckets — collect those buckets so the
  // caller can protect them from utilisation saves (an overstamp there would
  // evict the published resume point). The chunk address is the first 32
  // bytes of each 64-byte encrypted reference.
  const stateBuckets: number[] = [
    toBucket(refBytes.slice(0, 32)),
    ...statePointerPathBuckets(batchId, partition, owner, seq),
  ]

  // The feed points to the reference chunk: a single chunk holding the
  // 64-byte encrypted references (address‖key) of this partition's counter
  // chunks. Each reference carries its own decryption key, so no key
  // derivation is needed — downloadDataWithChunkAPI decrypts from the ref.
  //
  // Failure policy: the feed HAS an entry, so the partition has a real
  // resume point. If we cannot read it (transient network error, or a
  // published chunk evicted from the reserve), we must NOT fall back to a
  // zero counter — resuming at zero re-issues every used slot, and each
  // overstamp deterministically evicts the existing data chunk (Bee replaces
  // the older chunk at a colliding (bucket, slot) stamp index). Report
  // `readFailed` so the caller degrades to read-only and retries later.
  // Collected here so it survives the try for the success return. The full set
  // of per-chunk refs (sentinels included) lets the caller seed the lease's
  // `publishedReferences` for an incremental first publish.
  let references: Uint8Array[] = []
  try {
    const { numUtilizationChunks } = getChunkLayout(batchDepth)
    references = await downloadReferenceChunkRefs(
      bee,
      refBytes,
      numUtilizationChunks,
    )
    // Fire all counter-chunk downloads in one round — every address is already
    // in hand from the reference chunk, so serializing them would pay K×
    // gateway latency on the cold takeover path for nothing (mirrors the
    // parallelism the publish path uses). All-zero sentinel refs are chunks
    // that were never written: leave them zero, no download (sparse publish).
    const chunkReads = await Promise.all(
      references.map((ref, i) =>
        bytesAllZero(ref)
          ? undefined
          : downloadDataWithChunkAPI(bee, Binary.uint8ArrayToHex(ref)).then(
              (data) => ({ i, ref, data }),
            ),
      ),
    )
    for (const read of chunkReads) {
      if (read === undefined) continue
      mergeChunk(localCounter, read.i, read.data, batchDepth)
      stateBuckets.push(toBucket(read.ref.slice(0, 32)))
    }
    PartitionStateSchemaV1.parse({ counters: localCounter })
  } catch (err) {
    console.warn(
      `[partition-state] reading partition ${partition} counter failed; degrading to read-only:`,
      err,
    )
    // Don't return referenceHex — the read failed, so the caller must not
    // cache this reference as "synced" (it would skip a needed future download).
    return { unchanged: false, readFailed: true }
  }

  // No feed-SOC compensation needed: the state pointer is a reserved-slot SOC
  // (it overstamps the partition's reserved slot, like the counter chunks), so
  // it consumes no data slot that
  // the snapshot would have to account for.

  return {
    localCounter,
    referenceHex,
    seq,
    unchanged: false,
    stateBuckets,
    references,
  }
}

/**
 * Download a partition's reference chunk and split it into its N per-chunk
 * encrypted refs (address‖key), sentinels included. Throws on a missing chunk
 * or a wrong-length reference chunk (callers map that to `readFailed` on the
 * full-read path, or to `undefined` references on the best-effort cache-hit path).
 */
async function downloadReferenceChunkRefs(
  bee: Bee,
  refBytes: Uint8Array,
  numUtilizationChunks: number,
): Promise<Uint8Array[]> {
  const referenceChunk = await downloadDataWithChunkAPI(
    bee,
    new Reference(refBytes).toHex(),
  )
  const expectedLength = numUtilizationChunks * ENCRYPTED_REFERENCE_BYTES
  if (referenceChunk.length !== expectedLength) {
    throw new Error(
      `reference chunk has ${referenceChunk.length} bytes, expected ${expectedLength} (${numUtilizationChunks} × ${ENCRYPTED_REFERENCE_BYTES})`,
    )
  }
  return Array.from({ length: numUtilizationChunks }, (_, i) =>
    referenceChunk.slice(
      i * ENCRYPTED_REFERENCE_BYTES,
      (i + 1) * ENCRYPTED_REFERENCE_BYTES,
    ),
  )
}

/**
 * Publish the current `localCounter` to the partition-state feed.
 *
 * The counter is split into the same per-`chunkIndex` chunks the utilisation
 * store uses; each is uploaded with a random encryption key to this partition's
 * reserved slot (so it never consumes a data slot), yielding a 64-byte
 * encrypted reference (address‖key). A single "reference chunk" lists those
 * references and is itself uploaded the same way; the feed points at it. A
 * taking-over device follows the feed → reference chunk → counter chunks,
 * decrypting each from the embedded key.
 *
 * INCREMENTAL: pass `previousReferences` (the refs the last publish returned)
 * and `previousCounter` (the counter it published) to re-upload ONLY the chunks
 * that changed, reusing the retained refs for the rest. A typical upload changes
 * the data SOC's bucket plus the previous publish's feed-SOC bucket, so the
 * publish is ~3-4 chunks instead of the whole counter. Omit them (release, or
 * the first publish of a session) for a full publish.
 *
 * PARALLEL: every chunk address is content-derived, so the counter chunks and
 * the reference chunk are computed first and fired in a single `Promise.all`.
 * The pointer entry `seq` that names them is written once they are durable.
 */
export async function writePartitionState(opts: {
  bee: Bee
  stamper: Stamper
  batchId: BatchId
  batchDepth: number
  partition: number
  localCounter: Uint32Array
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  /**
   * This publish's place in the pointer sequence: one more than the newest
   * entry written. The caller holds the partition, so it is the only writer
   * of the sequence and knows that number.
   */
  seq: number
  /** Refs from the previous publish; with `previousCounter`, enables incremental. */
  previousReferences?: Uint8Array[]
  /** The counter the previous publish wrote; diffed to find changed chunks. */
  previousCounter?: Uint32Array
  /**
   * This device's id. When provided, the publish also avoids the buckets of
   * this device's current/previous-epoch intent beacons (the refresh tick
   * writes them off-lock at the same reserved slot). Omit for read-only / the
   * deviceId-independent paths — the pointer and occupancy buckets are avoided
   * regardless.
   */
  deviceId?: string
  /**
   * Wall-clock ms the rotating beacon addresses are anchored to. The lease
   * passes its own clock (`this.now()`, = `Date.now()` in production) so the
   * writer and the collision detector agree (#385). Defaults to `Date.now()`
   * for bare callers (direct unit tests).
   */
  nowMs?: number
}): Promise<{
  /** Reference-chunk reference (hex) — the caller's "synced reference". */
  referenceHex: string
  /** The pointer entry this publish wrote. */
  seq: number
  /**
   * Buckets occupied by the current state: the retained and re-uploaded
   * counter chunks, the reference chunk, and the pointer entries a search
   * depends on. The caller hands these to the stamper so subsequent
   * utilisation saves avoid overstamping (evicting) the publish.
   */
  stateBuckets: number[]
  /** The full ref set after this publish, for the caller to cache. */
  references: Uint8Array[]
  /** Snapshot of the counter this publish wrote (pass as `previousCounter` next). */
  publishedCounter: Uint32Array
}> {
  const {
    bee,
    stamper,
    batchId,
    batchDepth,
    partition,
    localCounter,
    backupSigner,
    swarmEncryptionKey,
    seq,
    previousReferences,
    previousCounter,
    deviceId,
    nowMs = Date.now(),
  } = opts

  PartitionStateSchemaV1.parse({ counters: localCounter })

  const { numUtilizationChunks } = getChunkLayout(batchDepth)
  const target: UploadTarget = { mode: "stamper", bee, stamper }
  const owner = backupSigner.publicKey().address()
  const reserve =
    stamper instanceof UtilizationAwareStamper ? stamper : undefined

  // Snapshot what we are about to publish BEFORE the feed SOC (uploaded below)
  // mutates the live counter — this is the exact resume point, cached by the
  // caller and diffed on the next publish.
  const publishedCounter = localCounter.slice()

  // Incremental only when we have a full previous ref set AND the counter it
  // published; otherwise re-upload every chunk (refs/diff unknown). Re-upload a
  // chunk iff its serialized bytes changed since the last publish — i.e. the
  // chunk(s) covering the bucket(s) this session's data upload(s) touched.
  // Reserved-slot writes (the prior publish's reference/pointer SOCs) never bump
  // the counter, so the data write is the only inter-publish counter delta.
  const incremental =
    previousReferences !== undefined &&
    previousReferences.length === numUtilizationChunks &&
    previousCounter !== undefined

  // KEYSTONE tripwire (fail loud, never silent slot reuse). The counter is a
  // monotonic per-bucket high-water, so any publish is always >= the one the last
  // publish recorded (see the SAFETY INVARIANT note in `PartitionLease.claimPartition`).
  // A regression means the stamper's counter/synced-ref persistence broke its
  // invariant. On the INCREMENTAL path it is actively dangerous — an unchanged-
  // looking chunk retains a ref ABOVE the live counter and a takeover resumes PAST
  // an acked slot into reuse. But it is a broken-persistence symptom on ANY path,
  // so guard on a known `previousCounter` ALONE, not `incremental`: the sparse-full
  // path is reachable with a previous counter but no refs (a cache-hit read whose
  // best-effort reference-chunk download failed seeds the lease that way), and a
  // regressed resume point must fail loud there too rather than ship silently.
  // Cheap: one pass over the 65536-entry counter, dwarfed by the ECDSA/upload work
  // below. (It catches the regression SYMPTOM; it cannot decode the retained refs'
  // own counters, so it is a tripwire, not a full proof.)
  if (previousCounter !== undefined) {
    for (let b = 0; b < NUM_BUCKETS; b++) {
      if (localCounter[b] < previousCounter[b]) {
        throw new Error(
          `[partition-state] publish p=${partition}: counter regressed at bucket ${b} ` +
            `(${localCounter[b]} < previous ${previousCounter[b]}) — monotonicity ` +
            "violation; refusing to publish a state a takeover could resume past an acked slot.",
        )
      }
    }
  }

  const allIndices = Array.from({ length: numUtilizationChunks }, (_, i) => i)
  // Which chunks to (re)upload:
  //  - incremental: those whose serialized bytes changed since the last publish
  //    (the chunk[s] covering the data write's bucket[s]; reserved-slot writes
  //    don't bump the counter, so the data write is the only delta).
  //  - full (first publish of a session): only the NON-ZERO chunks; zero chunks
  //    get the all-zero sentinel ref (not uploaded), so the first publish is
  //    sparse instead of writing all `numUtilizationChunks` (mostly zero).
  //    Counters are monotonic high-water — a chunk never returns to zero — so a
  //    real-ref chunk stays real and only never-written chunks are sentinels.
  //  - either way, a retained chunk standing in a pointer-entry bucket: this
  //    publish's own entry is written there and would replace it.
  const pathBuckets = statePointerPathBuckets(batchId, partition, owner, seq)
  const onPointerPath = new Set(pathBuckets)
  const uploadIndices = incremental
    ? allIndices.filter(
        (i) =>
          !bytesEqual(
            extractChunk(localCounter, i, batchDepth),
            extractChunk(previousCounter, i, batchDepth),
          ) ||
          (!bytesAllZero(previousReferences[i]) &&
            onPointerPath.has(toBucket(previousReferences[i].slice(0, 32)))),
      )
    : allIndices.filter(
        (i) => !bytesAllZero(extractChunk(localCounter, i, batchDepth)),
      )
  const uploadSet = new Set(uploadIndices)

  // Start from the retained refs (incremental) or all-zero sentinels (full).
  // Each sentinel is a fresh copy (not the shared `ZERO_CHUNK_REF` instance) so
  // the returned refs are mutually independent — an in-place byte write to one
  // zero slot can never bleed into another.
  const references: Uint8Array[] = incremental
    ? previousReferences.map((r) => r.slice())
    : allIndices.map(() => ZERO_CHUNK_REF.slice())

  // Every reserved chunk overstamps the partition's single reserved slot, so
  // they must land in distinct buckets, clear of the lock-SOC bucket, the live
  // utilisation chunks, the pointer entries a search depends on (this
  // publish's own included), and (incremental) the buckets of the REAL chunks
  // we retain (sentinel/zero chunks occupy no bucket).
  const claimedBuckets = new Set<number>([
    lockSocBucket(batchId, partition, owner),
    ...pathBuckets,
    ...(reserve?.getCleanChunkBuckets() ?? []),
  ])
  if (incremental) {
    for (let i = 0; i < numUtilizationChunks; i++) {
      if (!uploadSet.has(i) && !bytesAllZero(references[i]))
        claimedBuckets.add(toBucket(references[i].slice(0, 32)))
    }
  }

  // Other reserved-slot writers for this partition also stamp slot = partition,
  // so a counter/reference chunk sharing one of their buckets would evict — or
  // be evicted by — them under Bee's newer-stamp-wins replacement. Exclude their
  // buckets (current + previous epoch, covering the rotation boundary): the
  // deviceId-independent occupancy beacon, and (when known) this device's
  // intent beacon, both re-written off-lock by the refresh tick concurrently.
  // A peer's intent beacon uses its own deviceId and can't be computed here; that
  // residual stays fail-safe (an evicted beacon self-heals next tick). The
  // converse — a beacon at a LATER epoch (beyond the two excluded here) evicting
  // a RETAINED (incremental) counter/reference chunk — is healed by the holder's
  // once-per-epoch FULL re-pin (`PartitionLease.flushState`), which re-uploads
  // every non-zero chunk clear of the current epoch's beacons; a long-retained
  // chunk is therefore exposed for ~1 epoch, not the whole session. The only
  // unhealed case is an eviction in the final epoch before the holder vanishes:
  // that stays fail-safe, not silent corruption — the reference chunk then fails
  // to download on the next takeover and `readPartitionState` reports
  // `readFailed` (→ read-only + retry), never a zero-counter resume that would
  // re-issue acked slots. A beacon can replace a pointer entry the same way,
  // and that one is not healed: nothing rewrites an entry.
  // The lease's clock (`nowMs`), NOT a fresh `Date.now()`, so this is on the
  // same clock as the caller's collision detection (#385).
  const epoch = intentEpochBucket(nowMs)
  for (const beaconBucket of [epoch, epoch - 1]) {
    claimedBuckets.add(
      toBucket(
        partitionOccupancyAddress(batchId, partition, beaconBucket, owner),
      ),
    )
    if (deviceId !== undefined) {
      claimedBuckets.add(
        toBucket(
          intentSocAddress(batchId, partition, deviceId, beaconBucket, owner),
        ),
      )
    }
  }

  // Precompute (CPU only) a distinct-bucket key/address for each chunk we will
  // upload, marking it reserved so its `stamp()` routes to the reserved slot.
  const prepared = uploadIndices.map((i) => {
    const plaintext = extractChunk(localCounter, i, batchDepth)
    const picked = pickReservedChunkKey(plaintext, claimedBuckets)
    references[i] = picked.reference
    reserve?.markReservedUtilizationChunk(picked.address, partition)
    return { data: picked.data }
  })

  // The reference chunk lists every ref (N·64 bytes; ≤ 4096 even at N=64).
  const referenceChunk = Binary.concatBytes(...references)
  const refPicked = pickReservedChunkKey(referenceChunk, claimedBuckets)
  reserve?.markReservedUtilizationChunk(refPicked.address, partition)

  const referenceHex = Binary.uint8ArrayToHex(refPicked.reference)

  // Invariant the parallel PUTs below rely on: every reserved-slot chunk this
  // publish uploads must occupy a DISTINCT bucket. They all land at
  // slot=partition, so a shared bucket evicts one under Bee's newer-stamp-wins
  // replacement. `claimedBuckets` + `pickReservedChunkKey` already guarantee
  // distinctness by construction; assert it here so a future change to that
  // bucket-selection can't silently reintroduce a collision. (This covers the
  // distinct-bucket half of the parallel-safety invariant; the synchronous
  // slot assignment half is `UtilizationAwareStamper.assignSlot`'s, see the
  // comment on the Promise.all.)
  const writtenBuckets = [
    ...uploadIndices.map((i) => toBucket(references[i].slice(0, 32))),
    toBucket(refPicked.address),
  ]
  if (new Set(writtenBuckets).size !== writtenBuckets.length) {
    throw new Error(
      `[partition-state] publish p=${partition}: reserved-slot chunks collided ` +
        "on a bucket — parallel PUTs would race/evict. This is a bucket-" +
        "selection regression (pickReservedChunkKey / claimedBuckets).",
    )
  }

  // TWO-PHASE PUBLISH (#414). Phase 1: the dirty counter chunks + the reference
  // chunk. Phase 2 (only after ALL of phase 1 acks): the state-pointer SOC that
  // NAMES the reference chunk. The pointer must never become durable before the
  // chunks it references — with `deferred: false` a chunk PUT can fail while the
  // pointer PUT succeeds; if the holder then crashes, every takeover finds the
  // fresh pointer, fails to read its missing chunk(s) → `readFailed` → read-only
  // with no older-pointer fallback (stuck until batch expiry). Ordering the
  // pointer after the chunk acks costs one extra round-trip and closes that gap:
  // a failed chunk PUT rejects phase 1 before any pointer is written.
  //
  // CONCURRENCY: the phase-1 PUTs share one `stamper`. They are safe to fire in
  // parallel ONLY because (a) every chunk here lands in a DISTINCT bucket
  // (`claimedBuckets` above guarantees it) and (b) the stamper's `assignSlot()`
  // is synchronous, so each slot assignment runs to completion on the event
  // loop before another starts. If a future change introduces an await inside
  // it, concurrent stamps would race on the counters — serialize the PUTs (or
  // guard the slot) before doing so.
  // Upload the EXACT encrypted bytes picked above — re-encrypting here would
  // randomize the padding (sub-4096 plaintexts, e.g. the reference chunk) and
  // land the chunk at a different address than the one already reserved and
  // written into `references` / the pointer.
  const publishStart = Date.now()
  await Promise.all([
    ...prepared.map((p) => uploadChunk(target, p.data, { deferred: false })),
    uploadChunk(target, refPicked.data, { deferred: false }),
  ])
  await writeStatePointer({
    bee,
    stamper,
    backupSigner,
    swarmEncryptionKey,
    batchId,
    partition,
    pointer: { seq, referenceHex },
  })

  // Diagnostic (visible in the browser console): how many chunks this publish
  // actually wrote — counter chunks + the reference chunk + the pointer SOC —
  // and the batch latency. Shows whether a held-lease upload's publish is
  // sparse/incremental (~a few writes) or a full publish, and its gateway cost.
  console.debug(
    `[partition-state] publish p=${partition} incremental=${incremental} ` +
      `counterChunks=${prepared.length}/${numUtilizationChunks} ` +
      `writes=${prepared.length + 2} durationMs=${Date.now() - publishStart}`,
  )

  reserve?.clearReservedUtilizationChunks()

  // Only REAL (uploaded or retained) chunks occupy a reserved-slot bucket to
  // protect; sentinel (zero) chunks were never uploaded.
  const stateBuckets = references
    .filter((r) => !bytesAllZero(r))
    .map((r) => toBucket(r.slice(0, 32)))
  stateBuckets.push(toBucket(refPicked.address), ...pathBuckets)

  return {
    referenceHex,
    seq,
    stateBuckets,
    references,
    publishedCounter,
  }
}

/** True when every byte is zero (the zero-chunk / sentinel-ref test). */
function bytesAllZero(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== 0) return false
  }
  return true
}

/** Byte-wise equality for two equal-length chunk plaintexts. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Pick a random encryption key whose encrypted address lands in a bucket not
 * yet claimed (reserved chunks share one slot, so each must occupy a distinct
 * bucket), claim that bucket, and return the address + 64-byte reference +
 * encrypted chunk bytes. CPU only — the upload happens later, batched, and
 * must PUT these exact bytes: encryption padding is random, so re-encrypting
 * the plaintext would yield a different address. The bucket-distinctness retry
 * is why addresses are chosen in one synchronous pass before any PUT.
 */
function pickReservedChunkKey(
  plaintext: Uint8Array,
  claimedBuckets: Set<number>,
): { address: Uint8Array; reference: Uint8Array; data: Uint8Array } {
  let encrypted = makeEncryptedContentAddressedChunk(plaintext)
  while (claimedBuckets.has(toBucket(encrypted.address.toUint8Array()))) {
    encrypted = makeEncryptedContentAddressedChunk(plaintext)
  }
  const address = encrypted.address.toUint8Array()
  claimedBuckets.add(toBucket(address))
  return {
    address,
    reference: encrypted.reference.toUint8Array(),
    data: encrypted.data,
  }
}

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
 * The counter is packed as SBU1 leaves (`counter-codec.ts`: a base and bit
 * width chosen per publish, deltas packed to that width, outliers listed as
 * exceptions), each leaf uploaded with a random key to the partition's reserved
 * slot (never a data slot), and a single "reference chunk" carries the frame,
 * the exceptions, and the leaves' 64-byte encrypted references (address‖key).
 * The frame rides with the data, so a reader needs no batch depth and a dilute
 * changes no published byte (#463).
 *
 * The address of the latest reference chunk is published as a numbered,
 * write-once **state-pointer entry** (`readStatePointer`): publish 1, 2, 3, …
 * each write an encrypted SOC at an address computed from the number, and a
 * reader searches for the highest number written
 * (`state-pointer-search.ts`). No address is ever written twice, so a reader
 * is never served an older version of one, and the lookup needs no clock. See
 * docs/Postage-Batch-Partitioning.md (§8 cross-device handoff).
 *
 * Topic = keccak256("swarm-id-partition-state-v2" ‖ batchId ‖ uint32(partition))
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
  toBucket,
} from "../utils/batch-utilization"
import {
  type CounterException,
  type CounterFrame,
  MAX_DELTA_WIDTH,
  MAX_EXCEPTIONS,
  chooseFrame,
  decodeCounters,
  encodeCounters,
  frameFits,
  leafByteLength,
  leafCount,
} from "./counter-codec"
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
 * All-zero reference sentinel for a leaf whose bytes are all zero (every
 * bucket in it at the frame's base, none an exception). It is NOT uploaded —
 * the reference chunk just carries the sentinel at that index, and the reader
 * defaults a sentinel to a zero leaf. Keeps a full publish sparse: the
 * canonical base is the smallest counter, so a leaf no write has lifted above
 * it is all zero and costs nothing. Safe sentinel: a real ref is
 * `keccak256-address ‖ random-key`, never all-zero.
 */
const ZERO_CHUNK_REF = new Uint8Array(ENCRYPTED_REFERENCE_BYTES)

/**
 * Domain-separation tag for partition-state-feed topics. `v2` is the SBU1
 * leaf layout; state under `v1` (fixed-width uint16/uint32 chunks) is not
 * read (#463).
 */
const PARTITION_STATE_TOPIC_DOMAIN = "swarm-id-partition-state-v2"

/**
 * Reference-chunk header: width u8 ‖ base u32 ‖ exception count u16,
 * big-endian; then the exceptions (bucket u32 ‖ count u32) and one 64-byte
 * encrypted reference per leaf. `MAX_DELTA_WIDTH` keeps the whole of it within
 * one chunk at `MAX_EXCEPTIONS`. No checksum: each reference binds its leaf's
 * exact bytes (content address + key).
 */
const REFERENCE_HEADER_BYTES = 7
const REFERENCE_WIDTH_OFFSET = 0
const REFERENCE_BASE_OFFSET = 1
const REFERENCE_EXCEPTIONS_OFFSET = 5
const EXCEPTION_ENTRY_BYTES = 8

interface ReferenceChunk {
  frame: CounterFrame
  exceptions: CounterException[]
  /** One per leaf; `ZERO_CHUNK_REF` for a leaf that was never uploaded. */
  references: Uint8Array[]
}

function encodeReferenceChunk(chunk: ReferenceChunk): Uint8Array {
  const { frame, exceptions, references } = chunk
  const out = new Uint8Array(
    REFERENCE_HEADER_BYTES +
      EXCEPTION_ENTRY_BYTES * exceptions.length +
      ENCRYPTED_REFERENCE_BYTES * references.length,
  )
  const view = new DataView(out.buffer)
  view.setUint8(REFERENCE_WIDTH_OFFSET, frame.width)
  view.setUint32(REFERENCE_BASE_OFFSET, frame.base, false)
  view.setUint16(REFERENCE_EXCEPTIONS_OFFSET, exceptions.length, false)
  let at = REFERENCE_HEADER_BYTES
  for (const { bucket, count } of exceptions) {
    view.setUint32(at, bucket, false)
    view.setUint32(at + UINT32_BYTES, count, false)
    at += EXCEPTION_ENTRY_BYTES
  }
  for (const reference of references) {
    out.set(reference, at)
    at += ENCRYPTED_REFERENCE_BYTES
  }
  return out
}

/** Throws on a reference chunk its own header does not describe. */
function parseReferenceChunk(bytes: Uint8Array): ReferenceChunk {
  if (bytes.length < REFERENCE_HEADER_BYTES) {
    throw new Error(`reference chunk has ${bytes.length} bytes, no header`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint8(REFERENCE_WIDTH_OFFSET)
  if (width > MAX_DELTA_WIDTH) {
    throw new Error(`reference chunk names width ${width}`)
  }
  const base = view.getUint32(REFERENCE_BASE_OFFSET, false)
  const exceptionCount = view.getUint16(REFERENCE_EXCEPTIONS_OFFSET, false)
  if (exceptionCount > MAX_EXCEPTIONS) {
    throw new Error(`reference chunk names ${exceptionCount} exceptions`)
  }
  const leaves = leafCount(width)
  const expectedLength =
    REFERENCE_HEADER_BYTES +
    EXCEPTION_ENTRY_BYTES * exceptionCount +
    ENCRYPTED_REFERENCE_BYTES * leaves
  if (bytes.length !== expectedLength) {
    throw new Error(
      `reference chunk has ${bytes.length} bytes, expected ${expectedLength} (width ${width}: ${leaves} leaves, ${exceptionCount} exceptions)`,
    )
  }
  const exceptions: CounterException[] = []
  let at = REFERENCE_HEADER_BYTES
  for (let i = 0; i < exceptionCount; i++) {
    exceptions.push({
      bucket: view.getUint32(at, false),
      count: view.getUint32(at + UINT32_BYTES, false),
    })
    at += EXCEPTION_ENTRY_BYTES
  }
  const references = Array.from({ length: leaves }, (_, i) =>
    bytes.slice(
      at + i * ENCRYPTED_REFERENCE_BYTES,
      at + (i + 1) * ENCRYPTED_REFERENCE_BYTES,
    ),
  )
  return { frame: { base, width }, exceptions, references }
}

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
    // Serialized against another state-pointer write through this stamper,
    // so neither clobbers the shared reservation and mis-stamps into a data
    // slot.
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
 * Pass `known`, an entry this device remembers (its own last publish, or the
 * state it last read): when it is still there and nothing newer exists, the
 * lookup is one round and returns it. The hint only saves reads; the answer
 * is the one a search from nothing would give, and an entry that is no longer
 * there is not believed.
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
  const read = (seqs: number[]) => Promise.all(seqs.map(readEntry))
  // The remembered entry is read too, alongside the search that starts from
  // it: what a browser remembers can outlive what it describes (a format
  // change moves every entry, a local chain is reset). Not there: search
  // from nothing. Not settled: nothing found from it can be relied on.
  const [remembered, fromKnown] = await Promise.all([
    opts.known ? readEntry(opts.known.seq) : true,
    findLatestSeq({ known: opts.known?.seq ?? 0, read }),
  ])
  const { seq, inconclusive } =
    remembered === false ? await findLatestSeq({ known: 0, read }) : fromKnown
  const referenceHex = references.get(seq)
  return {
    pointer: referenceHex === undefined ? undefined : { seq, referenceHex },
    inconclusive: inconclusive || remembered === undefined,
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
    /**
     * A `readStatePointer` result the caller already fetched (speculatively,
     * ahead of the read) for this SAME
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
   * The per-leaf refs (sentinels included) and the frame the resume state was
   * assembled from — i.e. the reference chunk's contents. The caller seeds
   * these as its publish baseline so its FIRST publish is incremental against
   * the resumed state (only the changed leaf + reference chunk), not a full
   * re-publish. Present on a full read only.
   */
  references?: Uint8Array[]
  frame?: CounterFrame
}> {
  const { bee, owner, swarmEncryptionKey, batchId, partition } = opts

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

  // Nothing newer than the state the caller's counter is already in sync
  // with: it read or wrote that state itself and still has what it needs to
  // publish against it, so nothing is downloaded.
  if (known !== undefined && seq === known.seq) {
    return { referenceHex, seq, unchanged: true }
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

  // The pointer names the reference chunk: the frame, the exceptions, and the
  // 64-byte encrypted references (address‖key) of this partition's leaves.
  // Each reference carries its own decryption key, so no key derivation is
  // needed — downloadDataWithChunkAPI decrypts from the ref.
  //
  // Failure policy: the pointer HAS an entry, so the partition has a real
  // resume point. If we cannot read it (transient network error, or a
  // published chunk evicted from the reserve), we must NOT fall back to a
  // zero counter — resuming at zero re-issues every used slot, and each
  // overstamp deterministically evicts the existing data chunk (Bee replaces
  // the older chunk at a colliding (bucket, slot) stamp index). Report
  // `readFailed` so the caller degrades to read-only and retries later.
  let references: Uint8Array[] = []
  let frame: CounterFrame | undefined
  try {
    const referenceChunk = await downloadReferenceChunk(bee, refBytes)
    references = referenceChunk.references
    frame = referenceChunk.frame
    // Fire all leaf downloads in one round — every address is already in hand
    // from the reference chunk, so serializing them would pay K× gateway
    // latency on the cold takeover path for nothing. All-zero sentinel refs
    // are leaves that were never written: they stay zero, no download.
    const leaves: Uint8Array[] = references.map(
      (_, i) => new Uint8Array(leafByteLength(referenceChunk.frame.width, i)),
    )
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
      leaves[read.i] = read.data
      stateBuckets.push(toBucket(read.ref.slice(0, 32)))
    }
    localCounter.set(decodeCounters({ ...referenceChunk, leaves }))
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
    frame,
  }
}

/**
 * Download and parse a partition's reference chunk. Throws on a missing chunk
 * or one its own frame does not describe (the caller maps that to
 * `readFailed`).
 */
async function downloadReferenceChunk(
  bee: Bee,
  refBytes: Uint8Array,
): Promise<ReferenceChunk> {
  return parseReferenceChunk(
    await downloadDataWithChunkAPI(bee, new Reference(refBytes).toHex()),
  )
}

/**
 * Publish the current `localCounter` as the partition's state.
 *
 * The counter is packed into SBU1 leaves (`counter-codec.ts`); each is
 * uploaded with a random encryption key to this partition's reserved slot (so
 * it never consumes a data slot), yielding a 64-byte encrypted reference
 * (address‖key). A single "reference chunk" carries the frame, the exceptions
 * and those references, and is itself uploaded the same way; pointer entry
 * `seq` names it. A taking-over device follows the pointer → reference chunk
 * → leaves, decrypting each from the embedded key.
 *
 * INCREMENTAL: pass `previousReferences` (the refs the last publish returned),
 * `previousCounter` (the counter it published) and `previousFrame` (the frame
 * it packed with) to re-upload ONLY the leaves that changed, reusing the
 * retained refs for the rest. The previous frame is kept while it still fits
 * the counter, so leaf boundaries hold; a small upload then changes a leaf or
 * two plus the reference chunk. Omit them for a full publish under the
 * canonical frame. `previousCounter` must be EXACTLY the counter
 * `previousReferences` encode: a retained leaf goes out under a frame and
 * exception list computed from `localCounter`, and one that encodes any other
 * counter is a leaf the reference chunk does not describe — the reader
 * rejects the state.
 *
 * PARALLEL: every chunk address is content-derived, so the leaves and the
 * reference chunk are computed first and fired in a single `Promise.all`.
 * The pointer entry `seq` that names them is written once they are durable.
 */
export async function writePartitionState(opts: {
  bee: Bee
  stamper: Stamper
  batchId: BatchId
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
  /** The counter the previous publish wrote; diffed to find changed leaves. */
  previousCounter?: Uint32Array
  /** The frame the previous publish packed with; kept while it still fits. */
  previousFrame?: CounterFrame
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
  /** The frame it was packed with (pass as `previousFrame` next). */
  frame: CounterFrame
}> {
  const {
    bee,
    stamper,
    batchId,
    partition,
    localCounter,
    backupSigner,
    swarmEncryptionKey,
    seq,
    previousReferences,
    previousCounter,
    previousFrame,
  } = opts

  PartitionStateSchemaV1.parse({ counters: localCounter })

  // Incremental only when we have the previous publish's full ref set, the
  // counter it published and the frame it packed with, still fitting (a
  // counter only grows, so a base at or below the old minimum stays valid;
  // only an outgrown width or too many exceptions reject it). Keeping the
  // frame keeps every leaf's boundaries and bytes, so the per-leaf diff below
  // finds only the leaves a data write touched. Otherwise pack under the
  // canonical frame for this counter and publish in full.
  const previous = previousPublish(localCounter, {
    previousReferences,
    previousCounter,
    previousFrame,
  })
  const frame = previous?.frame ?? chooseFrame(localCounter)
  const encoded = encodeCounters(localCounter, frame)
  const numLeaves = encoded.leaves.length
  const target: UploadTarget = { mode: "stamper", bee, stamper }
  const owner = backupSigner.publicKey().address()
  const reserve =
    stamper instanceof UtilizationAwareStamper ? stamper : undefined

  // Snapshot what we are about to publish BEFORE the feed SOC (uploaded below)
  // mutates the live counter — this is the exact resume point, cached by the
  // caller and diffed on the next publish.
  const publishedCounter = localCounter.slice()

  const incremental = previous !== undefined

  // KEYSTONE tripwire (fail loud, never silent slot reuse). The counter is a
  // monotonic per-bucket high-water, so any publish is always >= the one the last
  // publish recorded (see the note in `LaneState.resume`).
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

  const allIndices = Array.from({ length: numLeaves }, (_, i) => i)
  // Which leaves to (re)upload:
  //  - incremental: those whose bytes changed since the last publish (the
  //    leaf[s] covering the data write's bucket[s]; reserved-slot writes don't
  //    bump the counter, so the data write is the only delta). The previous
  //    counter is packed under the SAME frame, so the comparison is exact.
  //  - full: only the NON-ZERO leaves; zero leaves get the all-zero sentinel
  //    ref (not uploaded), so a full publish is sparse. Deltas only grow under
  //    a kept frame — a leaf never returns to zero — so a real-ref leaf stays
  //    real and only never-written leaves are sentinels.
  //  - either way, a retained leaf standing in a pointer-entry bucket: this
  //    publish's own entry is written there and would replace it.
  const pathBuckets = statePointerPathBuckets(batchId, partition, owner, seq)
  const onPointerPath = new Set(pathBuckets)
  const previousLeaves = previous
    ? encodeCounters(previous.counter, frame).leaves
    : undefined
  const uploadIndices =
    previous && previousLeaves
      ? allIndices.filter(
          (i) =>
            !bytesEqual(encoded.leaves[i], previousLeaves[i]) ||
            (!bytesAllZero(previous.references[i]) &&
              onPointerPath.has(toBucket(previous.references[i].slice(0, 32)))),
        )
      : allIndices.filter((i) => !bytesAllZero(encoded.leaves[i]))
  const uploadSet = new Set(uploadIndices)

  // Start from the retained refs (incremental) or all-zero sentinels (full).
  // Each sentinel is a fresh copy (not the shared `ZERO_CHUNK_REF` instance) so
  // the returned refs are mutually independent — an in-place byte write to one
  // zero slot can never bleed into another.
  const references: Uint8Array[] = previous
    ? previous.references.map((r) => r.slice())
    : allIndices.map(() => ZERO_CHUNK_REF.slice())

  // Every reserved chunk overstamps the partition's single reserved slot, so
  // they must land in distinct buckets, clear of the live utilisation chunks, the pointer entries a search depends on (this
  // publish's own included), and (incremental) the buckets of the REAL chunks
  // we retain (sentinel/zero chunks occupy no bucket).
  const claimedBuckets = new Set<number>([
    ...pathBuckets,
    ...(reserve?.getCleanChunkBuckets() ?? []),
  ])
  if (incremental) {
    for (let i = 0; i < numLeaves; i++) {
      if (!uploadSet.has(i) && !bytesAllZero(references[i]))
        claimedBuckets.add(toBucket(references[i].slice(0, 32)))
    }
  }

  // Precompute (CPU only) a distinct-bucket key/address for each chunk we will
  // upload, marking it reserved so its `stamp()` routes to the reserved slot.
  const prepared = uploadIndices.map((i) => {
    const picked = pickReservedChunkKey(encoded.leaves[i], claimedBuckets)
    references[i] = picked.reference
    reserve?.markReservedUtilizationChunk(picked.address, partition)
    return { data: picked.data }
  })

  // The reference chunk: the frame, the exceptions, and every leaf's ref.
  const referenceChunk = encodeReferenceChunk({
    frame,
    exceptions: encoded.exceptions,
    references,
  })
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
      `leaves=${prepared.length}/${numLeaves} width=${frame.width} ` +
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
    frame,
  }
}

/**
 * The previous publish to diff against, when it is still comparable: the full
 * reference set of its frame's leaf count, the counter it published, and the
 * frame it packed with while it still fits `localCounter`.
 */
function previousPublish(
  localCounter: Uint32Array,
  prev: {
    previousReferences?: Uint8Array[]
    previousCounter?: Uint32Array
    previousFrame?: CounterFrame
  },
):
  | { references: Uint8Array[]; counter: Uint32Array; frame: CounterFrame }
  | undefined {
  const { previousReferences, previousCounter, previousFrame } = prev
  if (previousReferences === undefined || previousCounter === undefined) {
    return undefined
  }
  return previousFrame !== undefined &&
    previousReferences.length === leafCount(previousFrame.width) &&
    frameFits(localCounter, previousFrame)
    ? {
        references: previousReferences,
        counter: previousCounter,
        frame: previousFrame,
      }
    : undefined
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

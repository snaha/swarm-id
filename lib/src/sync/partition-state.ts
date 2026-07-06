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
 * The address of the latest reference chunk is published as a **rotating
 * per-epoch state-pointer SOC** (`writeStatePointer`/`readStatePointer`): the
 * identifier is `keccak256(topic ‖ uint64(floor(now / STATE_POINTER_EPOCH_MS)))`,
 * so a reader COMPUTES the address directly — no epoch-tree walk — and the
 * rotating address bypasses a gateway's frozen static-cache. The holder
 * heartbeats the pointer on every refresh, so a taking-over device finds it at
 * the current/previous bucket around `now` or the gone holder's `leasedUntil`.
 * Mirrors the occupancy beacon (`partition-intent.ts`). See
 * docs/Postage-Batch-Partitioning.md (§8 cross-device handoff).
 *
 * Topic = keccak256("swarm-id-partition-state-v1" ‖ batchId ‖ uint32(partition))
 * Owner = backup signer (`deriveSecret(swarmEncryptionKey, "backup-key")`)
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
import { z } from "zod"
import {
  downloadDataWithChunkAPI,
  downloadEncryptedSOC,
} from "../proxy/download-data"
import { uploadData, uploadSOC, type UploadTarget } from "../proxy/upload"
import { TimeoutError, withTimeout } from "../utils/promise"
import { makeEncryptedContentAddressedChunk } from "../chunk"
import {
  LEASE_TTL_MS,
  NUM_BUCKETS,
  UtilizationAwareStamper,
  extractChunk,
  getChunkLayout,
  mergeChunk,
  toBucket,
} from "../utils/batch-utilization"
import { lockSocBucket } from "../utils/lock-soc"
import {
  INTENT_EPOCH_MS,
  intentEpochBucket,
  intentSocAddress,
  partitionOccupancyAddress,
} from "./partition-intent"
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

/**
 * Granularity of the rotating state-pointer address — the SAME epoch the
 * intent/occupancy beacons rotate on: a reader computes a writer's bucket from
 * this shared constant, so the two must never drift apart (this module already
 * imports from partition-intent; there is no import cycle).
 *
 * COUPLING: the takeover lookup (`readStatePointer`) scans the whole
 * `LEASE_TTL_MS`-wide bucket span. The reads run CONCURRENTLY (each
 * timeout-bounded), so widening the span costs more parallel reads but not more
 * wall-clock — the lookup latency stays ~one read timeout regardless of the
 * `STATE_POINTER_EPOCH_MS` vs `LEASE_TTL_MS` ratio.
 */
export const STATE_POINTER_EPOCH_MS = INTENT_EPOCH_MS

/**
 * Extra epoch buckets the takeover lookup scans BELOW the lease-TTL span, to
 * tolerate a holder whose last few best-effort pointer heartbeats were dropped
 * (flaky gateway) while its lock SOC kept advancing `leasedUntil`. The lookup is
 * TTL-independent (see `readStatePointer`); this only sets how many dropped
 * final heartbeats it survives.
 */
const POINTER_LOOKUP_SLACK_BUCKETS = 2

/** Bound a single pointer read so an absent SOC doesn't block on peer exhaustion. */
const STATE_POINTER_READ_TIMEOUT_MS = SYNC_READ_TIMEOUT_MS

/**
 * Sentinel for a pointer-bucket read that TIMED OUT — distinct from `undefined`
 * (a clean miss / malformed blob). A timeout is INCONCLUSIVE: the bucket may hold
 * a pointer the slow gateway couldn't return, so "no pointer found" across the
 * scan is only authoritative when no candidate bucket timed out. Mirrors the
 * roster scan's `ROSTER_READ_TIMED_OUT`.
 */
const POINTER_READ_TIMED_OUT = Symbol("state-pointer-read-timed-out")
type PointerBucketRead =
  | { referenceHex: string }
  | undefined
  | typeof POINTER_READ_TIMED_OUT

/** `floor(nowMs / STATE_POINTER_EPOCH_MS)` — the current state-pointer epoch bucket. */
export function statePointerEpochBucket(nowMs: number): number {
  return Math.floor(nowMs / STATE_POINTER_EPOCH_MS)
}

/**
 * The state-pointer payload: the 64-byte reference of the latest published
 * reference chunk (address‖key). The reader picks the highest-numbered present
 * bucket (a holder writes contiguous buckets up to its last heartbeat), so the
 * bucket index already orders writes — no in-payload timestamp is needed.
 */
const StatePointerPayloadSchemaV1 = z.object({
  referenceHex: z.string(),
})

/**
 * SOC identifier for the partition's state pointer at `epochBucket`:
 * `keccak256(topic ‖ uint64(bucket))`. The address rotates every
 * `STATE_POINTER_EPOCH_MS`, so a reader computes it directly (no feed walk) and
 * the fresh address forces a network read that bypasses a gateway's frozen
 * static-cache — the same property the occupancy beacon relies on.
 */
function makeStatePointerIdentifier(
  topic: Topic,
  epochBucket: number,
): Identifier {
  const bucketBytes = new Uint8Array(8)
  new DataView(bucketBytes.buffer).setBigUint64(0, BigInt(epochBucket), false)
  return new Identifier(
    Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), bucketBytes)),
  )
}

/**
 * Publish the reference-chunk pointer at the current epoch bucket — a reserved-
 * slot, encrypted SOC (mirrors the occupancy beacon's `writeReservedPartitionSoc`).
 * Reserved-slot routed so it never consumes a data slot; overwrites within the
 * same 30 s bucket. Called per publish AND on the refresh-tick heartbeat so a
 * held partition always has a fresh pointer in the current bucket.
 */
export async function writeStatePointer(opts: {
  bee: Bee
  stamper: Stamper
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  batchId: BatchId
  partition: number
  referenceHex: string
  nowMs: number
}): Promise<void> {
  const topic = makePartitionStateTopic(opts.batchId, opts.partition)
  const epochBucket = statePointerEpochBucket(opts.nowMs)
  const identifier = makeStatePointerIdentifier(topic, epochBucket)
  const owner = opts.backupSigner.publicKey().address()
  const address = makeStatePointerAddress(identifier, owner)
  const data = new TextEncoder().encode(
    JSON.stringify({
      referenceHex: opts.referenceHex,
    }),
  )
  const target: UploadTarget = {
    mode: "stamper",
    bee: opts.bee,
    stamper: opts.stamper,
  }
  if (opts.stamper instanceof UtilizationAwareStamper) {
    // Serialized against concurrent intent/occupancy/pointer SOC writes (the
    // off-lock refresh-tick beacon vs. this under-lock publish) so neither
    // clobbers the shared intent-SOC reservation and mis-stamps into a data slot.
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

/** 32-byte SOC address `keccak256(identifier ‖ owner)`. */
function makeStatePointerAddress(
  identifier: Identifier,
  owner: EthAddress,
): Uint8Array {
  return Binary.keccak256(
    Binary.concatBytes(identifier.toUint8Array(), owner.toUint8Array()),
  )
}

/**
 * The 32-byte state-pointer SOC address for `partition` at the epoch bucket
 * covering `nowMs`. Exposed so `writePartitionState` can exclude the pointer's
 * bucket from the reserved-slot buckets its counter/reference chunks may use
 * (both land at slot = partition; a collision would evict one). Same derivation
 * `writeStatePointer` writes at.
 */
export function statePointerAddress(
  batchId: BatchId,
  partition: number,
  owner: EthAddress,
  nowMs: number,
): Uint8Array {
  const topic = makePartitionStateTopic(batchId, partition)
  const identifier = makeStatePointerIdentifier(
    topic,
    statePointerEpochBucket(nowMs),
  )
  return makeStatePointerAddress(identifier, owner)
}

/**
 * Read the latest state pointer by computing bucket addresses directly — no
 * feed walk. Checks (newest-first) the current/previous bucket around `now` and,
 * when given, the gone holder's lease span: every bucket from its last lock
 * refresh (`leasedUntil`) back through `leasedUntil - LEASE_TTL_MS` plus
 * {@link POINTER_LOOKUP_SLACK_BUCKETS} of slack. The holder heartbeats the
 * pointer at `floor(now / EPOCH)` on every refresh, so its last DURABLE pointer
 * lands somewhere in that span; scanning the whole span (rather than just the
 * `leasedUntil` bucket) makes the lookup independent of the
 * `STATE_POINTER_EPOCH_MS` vs `LEASE_TTL_MS` ratio AND tolerant of a couple of
 * dropped final heartbeats. Returns the freshest pointer found (`pointer`), or
 * `pointer: undefined` when none of the candidate buckets carry one.
 * `inconclusive` marks a verdict that is NOT authoritative: with no pointer, a
 * CLEAN scan (every candidate bucket read resolved) proves "no published state"
 * while ≥1 timed-out bucket leaves a pointer we couldn't fetch possible; with a
 * pointer found, a timed-out bucket NEWER than it may hide a fresher resume
 * point (a later acked publish), so the found pointer is only a stale
 * candidate. Either way the caller must fail safe on `inconclusive` rather
 * than resume. Ceiling: a holder dark for longer than
 * `LEASE_TTL_MS + POINTER_LOOKUP_SLACK_BUCKETS·EPOCH` past its last heartbeat
 * resumes from zero.
 */
async function readStatePointer(opts: {
  bee: Bee
  owner: EthAddress
  swarmEncryptionKey: Uint8Array
  batchId: BatchId
  partition: number
  nowMs: number
  holderLeasedUntilMs?: number
}): Promise<{ pointer?: { referenceHex: string }; inconclusive: boolean }> {
  const topic = makePartitionStateTopic(opts.batchId, opts.partition)
  const buckets = new Set<number>()
  const cur = statePointerEpochBucket(opts.nowMs)
  buckets.add(cur)
  buckets.add(cur - 1)
  if (opts.holderLeasedUntilMs !== undefined) {
    // Scan the whole lease span: from the final lock refresh (`leasedUntil`)
    // back through the earliest this lease could have heartbeated
    // (`leasedUntil - LEASE_TTL_MS`), minus slack for dropped final heartbeats.
    const hi = statePointerEpochBucket(opts.holderLeasedUntilMs)
    const lo =
      statePointerEpochBucket(opts.holderLeasedUntilMs - LEASE_TTL_MS) -
      POINTER_LOOKUP_SLACK_BUCKETS
    for (let b = lo; b <= hi; b++) buckets.add(b)
  }
  // Read every candidate bucket CONCURRENTLY (each timeout-bounded), then pick
  // the freshest present pointer. Parallel rather than a serial newest-first
  // short-circuit: a cold takeover scanning the whole lease span pays ~one read
  // timeout instead of N of them. A holder writes contiguous buckets up to its
  // last heartbeat, so the highest-numbered present bucket is the freshest — and
  // `ordered`/`Promise.all` preserve that newest-first order, so returning the
  // first present entry yields the same pointer the serial scan would have.
  const ordered = Array.from(buckets).sort((a, b) => b - a)
  const found: PointerBucketRead[] = await Promise.all(
    ordered.map(async (bucket) => {
      const identifier = makeStatePointerIdentifier(topic, bucket)
      try {
        const soc = await withTimeout(
          downloadEncryptedSOC(
            opts.bee,
            opts.owner,
            identifier,
            opts.swarmEncryptionKey,
          ),
          STATE_POINTER_READ_TIMEOUT_MS,
          "state-pointer read timed out",
        )
        const parsed = StatePointerPayloadSchemaV1.safeParse(
          JSON.parse(new TextDecoder().decode(soc.payload)),
        )
        return parsed.success ? parsed.data : undefined
      } catch (error) {
        // A timeout is INCONCLUSIVE (the slot may hold a pointer the slow gateway
        // couldn't return); a clean miss / malformed blob is a conclusive absent.
        return error instanceof TimeoutError
          ? POINTER_READ_TIMED_OUT
          : undefined
      }
    }),
  )
  // `ordered` is newest-first, so the first present entry is the freshest
  // pointer — but only a pointer with NO timed-out bucket above it is
  // authoritative. A newer bucket that timed out may hide a fresher pointer (a
  // later acked publish); returning the older one as conclusive would resume
  // below the acked high-water and re-issue acked slots. Surface that as
  // `inconclusive` so the caller fails safe instead of trusting a stale
  // candidate.
  for (let i = 0; i < found.length; i++) {
    const read = found[i]
    if (read !== undefined && read !== POINTER_READ_TIMED_OUT) {
      const newerTimedOut = found
        .slice(0, i)
        .some((newer) => newer === POINTER_READ_TIMED_OUT)
      return { pointer: read, inconclusive: newerTimedOut }
    }
  }
  // No pointer anywhere. Only a CLEAN scan (no bucket timed out) authoritatively
  // means "no state was published"; a timed-out candidate leaves it ambiguous.
  return {
    pointer: undefined,
    inconclusive: found.some((read) => read === POINTER_READ_TIMED_OUT),
  }
}

/**
 * Read the latest partition-state-feed entry and reconstruct the
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
 * Pass `knownReferenceHex` (the feed reference this device's local counter was
 * last in sync with) to short-circuit: when the feed still points there,
 * returns `{ unchanged: true }` WITHOUT downloading the reference/counter
 * chunks, and the caller reuses its local counter. On a real read it returns
 * the reconstructed `localCounter` plus the current `referenceHex` for the
 * caller to cache.
 */
export async function readPartitionState(
  opts: {
    bee: Bee
    owner: EthAddress
    swarmEncryptionKey: Uint8Array
    batchId: BatchId
    partition: number
    batchDepth: number
    /** Gone holder's `leasedUntil` (from the lock SOC) — locates the pointer of
     *  a partition that's been free for a while at its last-heartbeat bucket.
     *  A holder heartbeats the pointer up to its `leasedUntil`, so reading that
     *  bucket (and the one before) finds a published pointer durably, however
     *  long ago: "no pointer found" then reliably means "no state was published". */
    holderLeasedUntilMs?: number
    /**
     * True when this partition's lock SOC could not be read conclusively (a
     * transient/hanging read, NOT a clean 404). If we then find no published
     * pointer we must NOT assume "no state" and resume from zero — the lock may
     * be hiding an expired holder whose acked slots we'd re-issue. Treat that as
     * `readFailed` (degrade to read-only + retry) instead. A genuinely fresh
     * partition has a cleanly-absent lock (`false`) and still zero-seeds.
     */
    lockUnreadable?: boolean
    /**
     * Wall-clock ms to anchor the state-pointer lookup to — the reader half of
     * the rendezvous. The lease passes its own clock (`this.now()`, = `Date.now()`
     * in production) so the reader computes the same buckets the writer wrote at.
     * Defaults to `Date.now()` for bare callers. Injectable for deterministic /
     * per-device-skew tests (#385).
     */
    nowMs?: number
  },
  knownReferenceHex?: string,
): Promise<{
  localCounter?: Uint32Array
  referenceHex?: string
  unchanged: boolean
  /**
   * True when the feed HAS an entry but the reference chunk or a counter
   * chunk could not be read. The caller must NOT proceed with a zero
   * counter — the partition has a real resume point we failed to learn,
   * and stamping from zero would re-issue every used slot (each overstamp
   * evicts the existing data chunk from the reserve). Degrade to read-only
   * and retry instead.
   */
  readFailed?: boolean
  /**
   * Buckets occupied by the published state chunks (counter chunks + the
   * reference chunk) of the entry that was read. The caller hands these to
   * the stamper so utilisation saves avoid overstamping (and evicting) the
   * published resume point. Present only on a successful full read.
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
  const {
    bee,
    owner,
    swarmEncryptionKey,
    batchId,
    partition,
    batchDepth,
    holderLeasedUntilMs,
    lockUnreadable,
    nowMs = Date.now(),
  } = opts

  const { pointer, inconclusive: pointerInconclusive } = await readStatePointer(
    {
      bee,
      owner,
      swarmEncryptionKey,
      batchId,
      partition,
      nowMs,
      holderLeasedUntilMs,
    },
  )

  if (!pointer) {
    // No pointer in any candidate bucket (around `now` or the holder's
    // `leasedUntil`). "No pointer" is only proof of "no state" when the read
    // was CONCLUSIVE. Fail safe (degrade to read-only + retry) rather than
    // resume — which could re-issue a gone holder's acked slots, each overstamp
    // evicting its data chunk — whenever the verdict is not authoritative:
    //  - `lockUnreadable`: the lock read itself hung, so the lock may hide an
    //    expired holder whose state we'd resume over; OR
    //  - a candidate pointer-bucket read TIMED OUT (`pointerInconclusive`) on a
    //    partition that DID have a holder (`holderLeasedUntilMs` set — expired or
    //    released), so a real pointer may exist we just couldn't fetch. This is
    //    the read the rest of the handoff path guards everywhere else; without it
    //    a fast-but-empty lock read + all-slow pointer reads would silently
    //    zero-resume.
    // This guard runs BEFORE the local-synced-reference shortcut below: the
    // synced reference is per-device and never cleared by a PEER's activity, so
    // on an inconclusive scan it may be stale across a foreign holder's newer
    // publish — resuming `unchanged` from it would re-issue that holder's acked
    // slots just as surely as a zero-seed.
    if (
      lockUnreadable ||
      (pointerInconclusive && holderLeasedUntilMs !== undefined)
    ) {
      console.warn(
        `[partition-state] partition ${partition}: no pointer found but the read was inconclusive ` +
          `(lockUnreadable=${lockUnreadable === true} pointerTimedOut=${pointerInconclusive}); ` +
          "degrading to read-only instead of resuming.",
      )
      return { unchanged: false, readFailed: true }
    }
    // Conclusive no-pointer. A holder heartbeats its pointer up to
    // `leasedUntil`, so this reliably means no state was published — resume
    // from zero. (If we hold a local synced reference, keep it: same-device
    // reclaim within the trail.)
    if (knownReferenceHex !== undefined) {
      return { referenceHex: knownReferenceHex, unchanged: true }
    }
    // A genuinely fresh partition (no holder ever → `holderLeasedUntilMs`
    // undefined AND a cleanly-absent lock) still zero-seeds even if a pointer
    // read was slow: there is no prior state to protect, so first-claim proceeds.
    return { localCounter: new Uint32Array(NUM_BUCKETS), unchanged: false }
  }

  // A pointer WAS found but a bucket NEWER than it timed out: a fresher pointer
  // (a later acked publish) may be hidden behind the slow read, so this one is a
  // stale candidate, not the resume point. Resuming from it would re-issue the
  // acked slots published after it. The partition demonstrably HAS state, so
  // fail safe unconditionally (no fresh-partition exemption applies here).
  if (pointerInconclusive) {
    console.warn(
      `[partition-state] partition ${partition}: found a pointer but a newer ` +
        "bucket read timed out (a fresher resume point may be hidden); " +
        "degrading to read-only instead of resuming from a stale candidate.",
    )
    return { unchanged: false, readFailed: true }
  }

  const referenceHex = pointer.referenceHex
  const refBytes = new Reference(referenceHex).toUint8Array()

  // Cache hit: the pointer still names the reference this device's local counter
  // is already in sync with. Skip the COUNTER-chunk downloads — but still fetch
  // the single reference chunk so we can return its per-chunk refs, letting the
  // caller's FIRST publish be incremental against the resumed state rather than a
  // full re-publish. Best-effort: on failure omit `references` (the first publish
  // then falls back to the sparse-full path).
  if (knownReferenceHex !== undefined && referenceHex === knownReferenceHex) {
    const { numUtilizationChunks } = getChunkLayout(batchDepth)
    const references = await downloadReferenceChunkRefs(
      bee,
      refBytes,
      numUtilizationChunks,
    ).catch(() => undefined)
    return { referenceHex, unchanged: true, references }
  }

  const localCounter = new Uint32Array(NUM_BUCKETS)
  // The reference chunk and every counter chunk overstamp this partition's
  // reserved slot in their respective buckets — collect those buckets so the
  // caller can protect them from utilisation saves (an overstamp there would
  // evict the published resume point). The chunk address is the first 32
  // bytes of each 64-byte encrypted reference.
  const stateBuckets: number[] = [toBucket(refBytes.slice(0, 32))]

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
  // — unlike the old data-slot epoch feed entry — it consumes no data slot that
  // the snapshot would have to account for.

  return {
    localCounter,
    referenceHex,
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
 * PARALLEL: every chunk address is content-derived, so all PUTs (counter chunks
 * + reference chunk + state-pointer SOC) are computed first and fired in a
 * single `Promise.all`. The pointer is written at the current rotating epoch
 * bucket — no feed walk to publish, and the reader computes its address directly.
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
   * Wall-clock ms the rotating pointer/beacon rendezvous addresses are anchored
   * to. The lease passes its own clock (`this.now()`, = `Date.now()` in
   * production) so writer, reader, and the collision detector all agree (#385);
   * the reader anchors to the same clock. Defaults to `Date.now()` for bare
   * callers (direct unit tests). Injectable so a test can drive rendezvous
   * deterministically / model per-device skew.
   */
  nowMs?: number
}): Promise<{
  /** Reference-chunk reference (hex) — the caller's "synced reference". */
  referenceHex: string
  /**
   * Buckets occupied by the current state chunks (retained + re-uploaded
   * counter chunks + the reference chunk). The caller hands these to the
   * stamper so subsequent utilisation saves avoid overstamping (evicting) the
   * publish.
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
  const uploadIndices = incremental
    ? allIndices.filter(
        (i) =>
          !bytesEqual(
            extractChunk(localCounter, i, batchDepth),
            extractChunk(previousCounter, i, batchDepth),
          ),
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
  // utilisation chunks, and (incremental) the buckets of the REAL chunks we
  // retain (sentinel/zero chunks occupy no bucket).
  const claimedBuckets = new Set<number>([
    lockSocBucket(partition, owner),
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
  // buckets (current + previous epoch, covering the rotation boundary):
  //  - the state-pointer SOC this publish writes (phase 2 below)
  //    (an intra-publish self-collision otherwise);
  //  - the deviceId-independent occupancy beacon, and (when known) this device's
  //    intent beacon, both re-written off-lock by the refresh tick concurrently.
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
  // re-issue acked slots.
  // The lease's clock (`nowMs`), NOT a fresh `Date.now()`: the rotating pointer /
  // beacon addresses are a cross-device rendezvous, and a taking-over device
  // computes the same buckets from its OWN clock. In production the lease clock
  // IS `Date.now()`, so writer and reader still agree on wall-clock; threading it
  // (rather than reading `Date.now()` here) lets a test drive the rendezvous
  // deterministically and keeps this on the same clock as the caller's lease-
  // validity + collision-detection logic (#385).
  const now = nowMs
  for (const ptrMs of [now, now - STATE_POINTER_EPOCH_MS]) {
    claimedBuckets.add(
      toBucket(statePointerAddress(batchId, partition, owner, ptrMs)),
    )
  }
  const epoch = intentEpochBucket(now)
  for (const beaconBucket of [epoch, epoch - 1]) {
    claimedBuckets.add(
      toBucket(partitionOccupancyAddress(partition, beaconBucket, owner)),
    )
    if (deviceId !== undefined) {
      claimedBuckets.add(
        toBucket(intentSocAddress(partition, deviceId, beaconBucket, owner)),
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
    return { plaintext, key: picked.key }
  })

  // The reference chunk lists every ref (N·64 bytes; ≤ 4096 even at N=64).
  const referenceChunk = Binary.concatBytes(...references)
  const refPicked = pickReservedChunkKey(referenceChunk, claimedBuckets)
  reserve?.markReservedUtilizationChunk(refPicked.address, partition)

  const referenceHex = Binary.uint8ArrayToHex(refPicked.reference)

  // Invariant the parallel PUTs below rely on: every reserved-slot chunk this
  // publish uploads must occupy a DISTINCT bucket. They all land at
  // slot=partition, so a shared bucket both evicts one under Bee's newer-stamp-
  // wins replacement AND races the shared `buckets[bucket]` counter across the
  // concurrent stamps. `claimedBuckets` + `pickReservedChunkKey` already
  // guarantee distinctness by construction; assert it here so a future change to
  // that bucket-selection can't silently reintroduce a collision. (This covers
  // the distinct-bucket half of the parallel-safety invariant; the "no `await`
  // between the reserved-slot bucket-set and `stamp()`" half stays enforced by
  // the UtilizationAwareStamper stamp path and the comment on the Promise.all.)
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
  // (`claimedBuckets` above guarantees it) and (b) the reserved-slot `stamp()`
  // branches set `stamper.buckets[bucket]` and call `stamp()` with NO await
  // between them, so each critical section runs to completion on the event loop
  // before another starts. If a future change introduces an await inside those
  // branches, concurrent stamps would race on the shared `buckets` array —
  // serialize the PUTs (or guard the slot) before doing so.
  const publishStart = Date.now()
  await Promise.all([
    ...prepared.map((p) =>
      uploadData(target, p.plaintext, {
        encryptionKey: p.key,
        deferred: false,
      }),
    ),
    uploadData(target, referenceChunk, {
      encryptionKey: refPicked.key,
      deferred: false,
    }),
  ])
  await writeStatePointer({
    bee,
    stamper,
    backupSigner,
    swarmEncryptionKey,
    batchId,
    partition,
    referenceHex,
    nowMs: now,
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
  stateBuckets.push(toBucket(refPicked.address))

  return {
    referenceHex,
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
 * bucket), claim that bucket, and return the address + key + 64-byte reference.
 * CPU only — the upload happens later, batched. The bucket-distinctness retry
 * is why addresses are chosen in one synchronous pass before any PUT.
 */
function pickReservedChunkKey(
  plaintext: Uint8Array,
  claimedBuckets: Set<number>,
): { address: Uint8Array; key: Uint8Array; reference: Uint8Array } {
  let encrypted = makeEncryptedContentAddressedChunk(plaintext)
  while (claimedBuckets.has(toBucket(encrypted.address.toUint8Array()))) {
    encrypted = makeEncryptedContentAddressedChunk(plaintext)
  }
  const address = encrypted.address.toUint8Array()
  claimedBuckets.add(toBucket(address))
  return {
    address,
    key: encrypted.encryptionKey,
    reference: encrypted.reference.toUint8Array(),
  }
}

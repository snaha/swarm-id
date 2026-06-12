// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Partition-state feed for multi-device postage-batch sharing.
 *
 * Each `(batchId, partition)` pair has its own epoch feed. The current holder
 * publishes its per-partition counter on release; the next holder reads it on
 * acquire and resumes from exactly that counter, so the two devices never race
 * for the same `(bucket, slot)` pair during an orderly hand-off.
 *
 * The counter is not a single blob: it is split into the same per-`chunkIndex`
 * chunks the utilisation store uses, each uploaded with a random key to the
 * partition's reserved slot (never a data slot), and a single "reference chunk"
 * lists their 64-byte encrypted references (address‖key). The feed points at
 * the reference chunk. See docs/Postage-Batch-Partitioning.md.
 *
 * Topic = keccak256("swarm-id-partition-state-v1" ‖ batchId ‖ uint32(partition))
 * Owner = backup signer (`deriveSecret(swarmEncryptionKey, "backup-key")`)
 */

import {
  Bee,
  BatchId,
  EthAddress,
  PrivateKey,
  Reference,
  Topic,
  type Stamper,
} from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { z } from "zod"
import { AsyncEpochFinder } from "../proxy/feeds/epochs/async-finder"
import {
  BasicEpochUpdater,
  epochSocAddress,
} from "../proxy/feeds/epochs/updater"
import { downloadDataWithChunkAPI } from "../proxy/download-data"
import { uploadData, type UploadTarget } from "../proxy/upload"
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

/** Length of a Swarm encrypted reference: 32-byte address + 32-byte key. */
const ENCRYPTED_REFERENCE_BYTES = 64

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
    batchId: BatchId
    partition: number
    batchDepth: number
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
}> {
  const { bee, owner, batchId, partition, batchDepth } = opts
  const topic = makePartitionStateTopic(batchId, partition)
  const finder = new AsyncEpochFinder(bee, topic, owner)
  const now = BigInt(Math.floor(Date.now() / 1000))

  const entry = await finder.findAtWithMetadata(now)

  if (!entry) {
    // No prior state — start fresh from zero.
    return { localCounter: new Uint32Array(NUM_BUCKETS), unchanged: false }
  }

  const refBytes = entry.reference
  const referenceHex = Binary.uint8ArrayToHex(refBytes)

  // Cache hit: the feed still points to the reference this device's local
  // counter is already in sync with. Skip the reference-chunk + counter-chunk
  // downloads; the caller reuses its local counter.
  if (knownReferenceHex !== undefined && referenceHex === knownReferenceHex) {
    return { referenceHex, unchanged: true }
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
  try {
    const referenceChunk = await downloadDataWithChunkAPI(
      bee,
      new Reference(refBytes).toHex(),
    )
    const { numUtilizationChunks } = getChunkLayout(batchDepth)
    const expectedLength = numUtilizationChunks * ENCRYPTED_REFERENCE_BYTES
    if (referenceChunk.length !== expectedLength) {
      throw new Error(
        `reference chunk has ${referenceChunk.length} bytes, expected ${expectedLength} (${numUtilizationChunks} × ${ENCRYPTED_REFERENCE_BYTES})`,
      )
    }
    for (let i = 0; i < numUtilizationChunks; i++) {
      const ref = referenceChunk.slice(
        i * ENCRYPTED_REFERENCE_BYTES,
        (i + 1) * ENCRYPTED_REFERENCE_BYTES,
      )
      const chunkData = await downloadDataWithChunkAPI(
        bee,
        Binary.uint8ArrayToHex(ref),
      )
      mergeChunk(localCounter, i, chunkData, batchDepth)
      stateBuckets.push(toBucket(ref.slice(0, 32)))
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

  // Compensate for the feed entry's own SOC: `writePartitionState` extracts
  // and uploads the counter snapshot FIRST and writes the feed SOC LAST, so
  // the feed SOC consumed one data slot — `slot(snapshot[bucket])` of its own
  // address's bucket — that the snapshot does not record. Resuming without
  // this +1 would place the next data chunk in that bucket onto the feed
  // SOC's exact slot, evicting the feed entry from the reserve (Bee replaces
  // the older chunk at a colliding stamp index) and breaking later feed
  // walks. The bump is unconditional: if a future writer ever pre-accounted
  // the slot, the +1 merely wastes one slot in one bucket. Only this (the
  // latest) entry needs compensation — earlier entries were compensated by
  // the readers that consumed them. NOTE: the `unchanged` short-circuit above
  // must NOT bump — the caller's live counter already includes the increment
  // made when the feed SOC was stamped.
  const feedSocAddr = await epochSocAddress(topic, entry.epoch, owner)
  localCounter[toBucket(feedSocAddr)] += 1

  return { localCounter, referenceHex, unchanged: false, stateBuckets }
}

/**
 * Publish the current `localCounter` to the partition-state feed.
 *
 * Called from `PartitionLease.release()`. The counter is split into the same
 * per-`chunkIndex` chunks the utilisation store uses; each is uploaded with a
 * random encryption key to this partition's reserved slot (so it never
 * consumes a data slot), yielding a 64-byte encrypted reference (address‖key).
 * A single "reference chunk" lists those references and is itself uploaded the
 * same way; the feed points at it. A taking-over device follows the feed →
 * reference chunk → counter chunks, decrypting each from the embedded key.
 */
export async function writePartitionState(opts: {
  bee: Bee
  stamper: Stamper
  batchId: BatchId
  batchDepth: number
  partition: number
  localCounter: Uint32Array
  backupSigner: PrivateKey
}): Promise<{
  /** Feed reference (hex) — the caller's "synced reference". */
  referenceHex: string
  /**
   * Buckets occupied by the uploaded state chunks (counter chunks + the
   * reference chunk). The caller hands these to the stamper so subsequent
   * utilisation saves avoid overstamping (and evicting) this publish.
   */
  stateBuckets: number[]
}> {
  const {
    bee,
    stamper,
    batchId,
    batchDepth,
    partition,
    localCounter,
    backupSigner,
  } = opts

  PartitionStateSchemaV1.parse({ counters: localCounter })

  const { numUtilizationChunks } = getChunkLayout(batchDepth)
  const target: UploadTarget = { mode: "stamper", bee, stamper }
  const owner = backupSigner.publicKey().address()
  const reserve =
    stamper instanceof UtilizationAwareStamper ? stamper : undefined
  // Every chunk below overstamps the partition's reserved slot, so they must
  // land in distinct buckets, clear of the partition's lock-SOC bucket, and
  // clear of the live utilisation chunks (whose buckets share the same
  // reserved slot — landing there would evict them from the reserve).
  const claimedBuckets = new Set<number>([
    lockSocBucket(partition, owner),
    ...(reserve?.getCleanChunkBuckets() ?? []),
  ])

  // 1. Upload each counter chunk → 64-byte encrypted reference.
  const references: Uint8Array[] = []
  const stateBuckets: number[] = []
  for (let i = 0; i < numUtilizationChunks; i++) {
    const plaintext = extractChunk(localCounter, i, batchDepth)
    const ref = await uploadReservedChunk(
      target,
      plaintext,
      claimedBuckets,
      reserve,
    )
    references.push(ref)
    stateBuckets.push(toBucket(ref.slice(0, 32)))
  }

  // 2. Upload the reference chunk listing those references (N·64 bytes; ≤ 4096
  //    even at N=64, so a single chunk).
  const referenceChunk = Binary.concatBytes(...references)
  const referenceChunkRef = await uploadReservedChunk(
    target,
    referenceChunk,
    claimedBuckets,
    reserve,
  )
  stateBuckets.push(toBucket(referenceChunkRef.slice(0, 32)))

  reserve?.clearReservedUtilizationChunks()

  // 3. Point the partition-state feed at the reference chunk.
  const topic = makePartitionStateTopic(batchId, partition)
  const updater = new BasicEpochUpdater(topic, backupSigner)
  await updater.update(
    BigInt(Math.floor(Date.now() / 1000)),
    referenceChunkRef,
    target,
  )

  // Return the feed reference so the caller can record it as this device's
  // "synced reference" (skips re-downloading on the next acquire), plus the
  // buckets the publish occupied so saves can avoid evicting it.
  return {
    referenceHex: Binary.uint8ArrayToHex(referenceChunkRef),
    stateBuckets,
  }
}

/**
 * Upload one chunk with a random encryption key to the partition's reserved
 * slot, returning its 64-byte encrypted reference (address‖key). Retries the
 * random key until the encrypted address lands in a bucket not yet claimed by
 * another reserved chunk (they all share the same reserved slot, so each must
 * occupy a distinct bucket).
 */
async function uploadReservedChunk(
  target: UploadTarget,
  plaintext: Uint8Array,
  claimedBuckets: Set<number>,
  reserve: UtilizationAwareStamper | undefined,
): Promise<Uint8Array> {
  let encrypted = makeEncryptedContentAddressedChunk(plaintext)
  while (claimedBuckets.has(toBucket(encrypted.address.toUint8Array()))) {
    encrypted = makeEncryptedContentAddressedChunk(plaintext)
  }
  const address = encrypted.address.toUint8Array()
  claimedBuckets.add(toBucket(address))
  reserve?.markReservedUtilizationChunk(address)
  await uploadData(target, plaintext, {
    encryptionKey: encrypted.encryptionKey,
    deferred: false,
  })
  return encrypted.reference.toUint8Array()
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Partition-state feed for multi-device postage-batch sharing.
 *
 * Each `(batchId, partition)` pair has its own epoch feed. The current holder
 * publishes its per-partition counter on release; the next holder reads it on
 * acquire and seeds its own counter (with a defensive skew) so the two devices
 * never race for the same `(bucket, slot)` pair.
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
import { AsyncEpochFinder } from "../proxy/feeds/epochs/async-finder"
import { BasicEpochUpdater } from "../proxy/feeds/epochs/updater"
import { downloadDataWithChunkAPI } from "../proxy/download-data"
import { uploadData, type UploadTarget } from "../proxy/upload"
import { makeEncryptedContentAddressedChunk } from "../chunk"
import {
  NUM_BUCKETS,
  UtilizationAwareStamper,
  computeResumeCounterSkew,
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
 * `localCounter` array, defensively skewed by `RESUME_COUNTER_SKEW`.
 *
 * Returns a fresh zero-filled-then-skewed array when no prior snapshot
 * exists — i.e. when a fresh partition is being seeded for the first time
 * (Case A on a brand-new account, or Case B when no peer has yet
 * published on the partition we're about to take).
 */
export async function readPartitionState(opts: {
  bee: Bee
  owner: EthAddress
  batchId: BatchId
  partition: number
  batchDepth: number
}): Promise<{ localCounter: Uint32Array }> {
  const { bee, owner, batchId, partition, batchDepth } = opts
  const topic = makePartitionStateTopic(batchId, partition)
  const finder = new AsyncEpochFinder(bee, topic, owner)
  const now = BigInt(Math.floor(Date.now() / 1000))

  const refBytes = await finder.findAt(now)
  const localCounter = new Uint32Array(NUM_BUCKETS)
  const skew = computeResumeCounterSkew(batchDepth)

  if (!refBytes) {
    // No prior state — start fresh (still apply the skew so peers that
    // didn't yet publish but may have already stamped a few chunks under
    // a crashed session can't collide with us).
    localCounter.fill(skew)
    return { localCounter }
  }

  // The feed points to the reference chunk: a single chunk holding the
  // 64-byte encrypted references (address‖key) of this partition's counter
  // chunks. Each reference carries its own decryption key, so no key
  // derivation is needed — downloadDataWithChunkAPI decrypts from the ref.
  const referenceChunk = await downloadDataWithChunkAPI(
    bee,
    new Reference(refBytes).toHex(),
  )
  const { numUtilizationChunks } = getChunkLayout(batchDepth)
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
  }

  // Skew past where the previous holder stopped (defends against a crashed
  // peer's un-published in-flight writes).
  for (let i = 0; i < NUM_BUCKETS; i++) localCounter[i] += skew
  return { localCounter }
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
}): Promise<void> {
  const {
    bee,
    stamper,
    batchId,
    batchDepth,
    partition,
    localCounter,
    backupSigner,
  } = opts

  if (localCounter.length !== NUM_BUCKETS) {
    throw new Error(
      `localCounter must have ${NUM_BUCKETS} entries, got ${localCounter.length}`,
    )
  }

  const { numUtilizationChunks } = getChunkLayout(batchDepth)
  const target: UploadTarget = { mode: "stamper", bee, stamper }
  const owner = backupSigner.publicKey().address()
  // Every chunk below overstamps the partition's reserved slot, so they must
  // land in distinct buckets and clear of the partition's lock-SOC bucket.
  const claimedBuckets = new Set<number>([lockSocBucket(partition, owner)])
  const reserve =
    stamper instanceof UtilizationAwareStamper ? stamper : undefined

  // 1. Upload each counter chunk → 64-byte encrypted reference.
  const references: Uint8Array[] = []
  for (let i = 0; i < numUtilizationChunks; i++) {
    const plaintext = extractChunk(localCounter, i, batchDepth)
    references.push(
      await uploadReservedChunk(target, plaintext, claimedBuckets, reserve),
    )
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

  reserve?.clearReservedUtilizationChunks()

  // 3. Point the partition-state feed at the reference chunk.
  const topic = makePartitionStateTopic(batchId, partition)
  const updater = new BasicEpochUpdater(topic, backupSigner)
  await updater.update(
    BigInt(Math.floor(Date.now() / 1000)),
    referenceChunkRef,
    target,
  )
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

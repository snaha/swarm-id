// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Partition-state feed for multi-device postage-batch sharing.
 *
 * Each `(batchId, partition)` pair has its own epoch feed carrying the
 * device's `localCounter: Uint32Array(65536)`. The current holder publishes
 * the counter on release; the next holder reads it on acquire and seeds
 * its own local counter (with a defensive skew) so the two devices never
 * race for the same `(bucket, slot)` pair.
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
import {
  NUM_BUCKETS,
  PARTITION_COUNT,
  RESUME_COUNTER_SKEW_DIVISOR,
  BUCKET_DEPTH,
  deserializeUint32Array,
  serializeUint32Array,
} from "../utils/batch-utilization"
import { PartitionStateSchemaV1, type PartitionState } from "../schemas"

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
 * Counter-skew applied when seeding `localCounter` from a peer's
 * partition-state snapshot. The previous holder may have stamped chunks
 * after its last published snapshot before crashing; skipping a small
 * slot range eliminates the residual collision risk.
 */
export function computeResumeCounterSkew(batchDepth: number): number {
  const slotsPerBucket = Math.pow(2, batchDepth - BUCKET_DEPTH)
  return Math.ceil(
    slotsPerBucket / PARTITION_COUNT / RESUME_COUNTER_SKEW_DIVISOR,
  )
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
}): Promise<{
  localCounter: Uint32Array
  publishedBy?: string
  publishedAt?: number
}> {
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

  const reference = new Reference(refBytes)
  const payloadJson = await downloadDataWithChunkAPI(bee, reference.toHex())
  const parsed = PartitionStateSchemaV1.parse(
    JSON.parse(new TextDecoder().decode(payloadJson)),
  )
  // The schema stores `bucketCounters` as Uint8Array via z.instanceof; after
  // JSON round-trip we re-receive it as a plain object {0: …, 1: …}. Coerce.
  const bytes = coerceUint8Array(parsed.bucketCounters)
  const decoded = deserializeUint32Array(bytes)
  if (decoded.length !== NUM_BUCKETS) {
    throw new Error(
      `Partition-state payload has ${decoded.length} counters, expected ${NUM_BUCKETS}`,
    )
  }
  for (let i = 0; i < NUM_BUCKETS; i++) {
    localCounter[i] = decoded[i] + skew
  }
  return {
    localCounter,
    publishedBy: parsed.publishedBy,
    publishedAt: parsed.publishedAt,
  }
}

/**
 * Publish the current `localCounter` to the partition-state feed.
 *
 * Called from `PartitionLease.release()` — the only path that writes
 * here, so the steady-state writer touches this feed zero times during a
 * long session.
 */
export async function writePartitionState(opts: {
  bee: Bee
  stamper: Stamper
  batchId: BatchId
  partition: number
  localCounter: Uint32Array
  deviceId: string
  swarmEncryptionKey: Uint8Array
  backupSigner: PrivateKey
}): Promise<void> {
  const {
    bee,
    stamper,
    batchId,
    partition,
    localCounter,
    deviceId,
    swarmEncryptionKey,
    backupSigner,
  } = opts

  if (localCounter.length !== NUM_BUCKETS) {
    throw new Error(
      `localCounter must have ${NUM_BUCKETS} entries, got ${localCounter.length}`,
    )
  }

  const payload: PartitionState = {
    bucketCounters: serializeUint32Array(localCounter),
    publishedBy: deviceId,
    publishedAt: Date.now(),
  }
  const payloadJson = new TextEncoder().encode(
    JSON.stringify({
      ...payload,
      // Serialise the Uint8Array as a plain number-array so JSON.parse on
      // the read side can rebuild it. See `coerceUint8Array` above.
      bucketCounters: Array.from(payload.bucketCounters),
    }),
  )

  // 1. Upload the encrypted payload via the existing stamper.
  const target: UploadTarget = { mode: "stamper", bee, stamper }
  const uploadResult = await uploadData(target, payloadJson, {
    encryptionKey: swarmEncryptionKey,
  })

  // 2. Point the partition-state feed at the new reference.
  const topic = makePartitionStateTopic(batchId, partition)
  const updater = new BasicEpochUpdater(topic, backupSigner)
  const refBytes = new Reference(uploadResult.reference).toUint8Array()
  const feedTimestamp = BigInt(Math.floor(Date.now() / 1000))
  await updater.update(feedTimestamp, refBytes, target)
}

/**
 * After a JSON round-trip a `Uint8Array` arrives as either a plain object
 * `{ 0: number, 1: number, … }` or a number array. Normalise to a real
 * `Uint8Array` so `deserializeUint32Array` can read it.
 */
function coerceUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return new Uint8Array(value)
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, number>)
      .map(([k, v]) => [Number(k), v] as const)
      .sort(([a], [b]) => a - b)
    const arr = new Uint8Array(entries.length)
    for (const [i, v] of entries) arr[i] = v
    return arr
  }
  throw new Error("Cannot coerce value to Uint8Array")
}

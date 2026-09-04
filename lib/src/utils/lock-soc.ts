// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Address derivation for the per-partition lock SOC. Lives in `utils/` (not
 * `sync/`) so it can be imported by both `sync/partition-lock.ts` (the lock
 * SOC reader/writer) and `utils/batch-utilization.ts` (the stamper that
 * routes lock-SOC overstamps to the reserved slot) without a circular
 * dependency through `toBucket`.
 */

import { Identifier, type BatchId, type EthAddress } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"

/** Domain separation tag for the lock-SOC identifier. */
const PARTITION_LOCK_DOMAIN = "swarm-id-partition-lock-v1"

/**
 * Build the lock-SOC identifier for one partition of one batch. Universal
 * across accounts — the per-account `owner` carries that separation — so the
 * identifier encodes what remains: which batch, and which of its lanes.
 *
 * The batch is in here because it is in everything the lock protects. A lane's
 * slot space is computed WITHIN a batch (`dataSlot`), and the state riding it
 * is published under `makePartitionStateTopic(batchId, partition)`. Keying the
 * lock on the partition alone made lane p of batch X and lane p of batch Y one
 * chunk address, so two coordinators that share no slot took turns anyway —
 * and per-app stamp overrides put two live coordinators on two batches without
 * any multi-batch feature (#589).
 */
export function makePartitionLockIdentifier(
  batchId: BatchId,
  partition: number,
): Identifier {
  const hash = Binary.keccak256(
    new TextEncoder().encode(
      `${PARTITION_LOCK_DOMAIN}:${batchId.toHex()}:${partition}`,
    ),
  )
  return new Identifier(hash)
}

/**
 * 32-byte SOC chunk address for the (batch, partition, owner) lock SOC. Used
 * by the stamper to detect "this stamp is the lock SOC's overstamp" and route
 * it to the reserved slot.
 */
export function lockSocAddress(
  batchId: BatchId,
  partition: number,
  owner: EthAddress,
): Uint8Array {
  const identifier = makePartitionLockIdentifier(batchId, partition)
  return Binary.keccak256(
    Binary.concatBytes(identifier.toUint8Array(), owner.toUint8Array()),
  )
}

/**
 * Bucket index that the partition-lock SOC for (batch, partition, owner) lands
 * in. Lock-SOC writes overstamp this single fixed bucket; the partition stamper
 * reserves the bucket from data uploads so the tight heartbeat cadence
 * doesn't exhaust the bucket's slot budget.
 */
export function lockSocBucket(
  batchId: BatchId,
  partition: number,
  owner: EthAddress,
): number {
  const addr = lockSocAddress(batchId, partition, owner)
  // Inline `toBucket` (first 2 bytes as big-endian uint16) to avoid a
  // circular import from `batch-utilization.ts`.
  return (addr[0] << 8) | addr[1]
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Address derivation for the per-partition lock SOC. Lives in `utils/` (not
 * `sync/`) so it can be imported by both `sync/partition-lock.ts` (the lock
 * SOC reader/writer) and `utils/batch-utilization.ts` (the stamper that
 * routes lock-SOC overstamps to the reserved slot) without a circular
 * dependency through `toBucket`.
 */

import { Identifier, type EthAddress } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"

/** Domain separation tag for the lock-SOC identifier. */
const PARTITION_LOCK_DOMAIN = "swarm-id-partition-lock-v1"

/**
 * Build the per-partition lock-SOC identifier. Universal across accounts —
 * the per-account `owner` carries the domain separation, so the identifier
 * itself only encodes the partition number.
 */
export function makePartitionLockIdentifier(partition: number): Identifier {
  const hash = Binary.keccak256(
    new TextEncoder().encode(`${PARTITION_LOCK_DOMAIN}:${partition}`),
  )
  return new Identifier(hash)
}

/**
 * 32-byte SOC chunk address for the (partition, owner) lock SOC. Used by
 * the stamper to detect "this stamp is the lock SOC's overstamp" and route
 * it to the reserved slot.
 */
export function lockSocAddress(
  partition: number,
  owner: EthAddress,
): Uint8Array {
  const identifier = makePartitionLockIdentifier(partition)
  return Binary.keccak256(
    Binary.concatBytes(identifier.toUint8Array(), owner.toUint8Array()),
  )
}

/**
 * Bucket index that the partition-lock SOC for (partition, owner) lands in.
 * Lock-SOC writes overstamp this single fixed bucket; the partition stamper
 * reserves the bucket from data uploads so the tight heartbeat cadence
 * doesn't exhaust the bucket's slot budget.
 */
export function lockSocBucket(partition: number, owner: EthAddress): number {
  const addr = lockSocAddress(partition, owner)
  // Inline `toBucket` (first 2 bytes as big-endian uint16) to avoid a
  // circular import from `batch-utilization.ts`.
  return (addr[0] << 8) | addr[1]
}

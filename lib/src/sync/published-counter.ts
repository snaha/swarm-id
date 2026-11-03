// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BatchId, Bee, PrivateKey } from "@ethersphere/bee-js"
import { NUM_BUCKETS } from "../utils/batch-utilization"
import { withTimeout } from "../utils/promise"
import { readPartitionLock } from "./partition-lock"
import { readPartitionState } from "./partition-state"
import { SYNC_READ_TIMEOUT_MS } from "./timing-constants"

/**
 * A bound for a caller's whole read: the lock and the state pointer each have
 * their own, the counter chunks' downloads do not
 */
export const PUBLISHED_COUNTER_READ_TIMEOUT_MS = 4 * SYNC_READ_TIMEOUT_MS

export interface PublishedCounter {
  dataCounters: Uint32Array
  /** The published state it came from; undefined when nothing was published */
  referenceHex: string | undefined
}

/**
 * A partition's per-bucket counter as its holder last published it, read
 * without claiming anything: the same lock and state-pointer reads a takeover
 * makes (`PartitionLease.claimPartition`), so it finds a long-gone holder's
 * state too. A partition that never published reads as empty. `undefined`
 * when the state exists but could not be read.
 *
 * Pass the `known` result of an earlier read: when the partition still points
 * at the same state, it is returned without downloading the counter again.
 */
export async function readPublishedCounter(
  opts: {
    bee: Bee
    backupSigner: PrivateKey
    swarmEncryptionKey: Uint8Array
    batchId: BatchId
    partition: number
  },
  known?: PublishedCounter,
): Promise<PublishedCounter | undefined> {
  const { bee, backupSigner, swarmEncryptionKey, batchId, partition } = opts
  let lockUnreadable = false
  const lock = await withTimeout(
    readPartitionLock({
      bee,
      backupSigner,
      swarmEncryptionKey,
      batchId,
      partition,
    }),
    SYNC_READ_TIMEOUT_MS,
    "lock read timed out",
  ).catch(() => {
    lockUnreadable = true
    return undefined
  })
  const state = await readPartitionState(
    {
      bee,
      owner: backupSigner.publicKey().address(),
      swarmEncryptionKey,
      batchId,
      partition,
      holderLeasedUntilMs: lock?.leasedUntil,
      lockUnreadable,
    },
    known?.referenceHex,
  )
  if (state.readFailed) return undefined
  if (state.unchanged && known) return known
  return {
    dataCounters: state.localCounter ?? new Uint32Array(NUM_BUCKETS),
    referenceHex: state.referenceHex,
  }
}

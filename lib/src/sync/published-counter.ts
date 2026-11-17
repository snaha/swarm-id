// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BatchId, Bee, PrivateKey } from "@ethersphere/bee-js"
import { NUM_BUCKETS } from "../utils/batch-utilization"
import { readPartitionState, type StatePointer } from "./partition-state"
import { SYNC_READ_TIMEOUT_MS } from "./timing-constants"

/**
 * A bound for a caller's whole read: each round of the state-pointer search
 * has its own, the counter chunks' downloads do not
 */
export const PUBLISHED_COUNTER_READ_TIMEOUT_MS = 4 * SYNC_READ_TIMEOUT_MS

export interface PublishedCounter {
  dataCounters: Uint32Array
  /** The published state it came from; undefined when nothing was published */
  pointer: StatePointer | undefined
}

/**
 * A partition's per-bucket counter as its holder last published it, read
 * without claiming anything: the same state-pointer search a takeover makes
 * (`PartitionLease.claimPartition`), so it finds a long-gone holder's state
 * too. A partition that never published reads as empty. `undefined` when the
 * state may exist but could not be read.
 *
 * Pass the `known` result of an earlier read: when nothing newer was
 * published, it is returned without downloading the counter again.
 */
export async function readPublishedCounter(
  opts: {
    bee: Bee
    backupSigner: PrivateKey
    swarmEncryptionKey: Uint8Array
    batchId: BatchId
    batchDepth: number
    partition: number
  },
  known?: PublishedCounter,
): Promise<PublishedCounter | undefined> {
  const { bee, backupSigner, swarmEncryptionKey, batchId, partition } = opts
  const state = await readPartitionState(
    {
      bee,
      owner: backupSigner.publicKey().address(),
      swarmEncryptionKey,
      batchId,
      partition,
      batchDepth: opts.batchDepth,
    },
    known?.pointer,
  )
  if (state.readFailed) return undefined
  if (state.unchanged && known) return known
  return {
    dataCounters: state.localCounter ?? new Uint32Array(NUM_BUCKETS),
    pointer:
      state.referenceHex !== undefined && state.seq !== undefined
        ? { seq: state.seq, referenceHex: state.referenceHex }
        : undefined,
  }
}

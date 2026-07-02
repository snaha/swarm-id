// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { Bee, PrivateKey } from '@ethersphere/bee-js'
import { DEFAULT_BEE_NODE_URL } from '@snaha/swarm-id'

import { strip0x } from '$lib/crypto/hex'
import type { NewStamp } from '$lib/payment/purchase'

/**
 * The product UI's postage ("drive") operations against a Bee node, as a thin
 * adapter over the bee-js client. All node interaction goes through bee-js —
 * don't hand-roll fetch calls against the node API here.
 */

/**
 * Look up an existing batch on a Bee node and shape it into a stamp record.
 * Returns `undefined` when the node doesn't track the batch or is unreachable —
 * the caller surfaces that to the user rather than attaching a half-known drive.
 */
export async function fetchExistingStamp(
  batchId: string,
  signerKey: PrivateKey,
  name: string,
  beeUrl: string = DEFAULT_BEE_NODE_URL,
): Promise<NewStamp | undefined> {
  try {
    const batch = await new Bee(beeUrl).getPostageBatch(strip0x(batchId))
    return {
      batchID: batch.batchID,
      name,
      signerKey,
      depth: batch.depth,
      amount: BigInt(batch.amount),
      bucketDepth: batch.bucketDepth,
      blockNumber: batch.blockNumber,
      immutableFlag: batch.immutableFlag,
      // bee-js precomputes `usage` as the 0–1 fraction the UI reads.
      utilization: batch.usage,
      usable: batch.usable,
      // getPostageBatch throws when the node doesn't track the batch, so a
      // batch that made it here exists by construction.
      exists: true,
      batchTTL: batch.duration.toSeconds(),
    }
  } catch {
    return undefined
  }
}

/**
 * Add funds to an existing batch, extending its lifespan. The node must own
 * the batch; rejects with the node's error otherwise. `amount` is the
 * additional per-chunk balance in PLUR.
 */
export async function topUpStamp(
  batchId: string,
  amount: bigint,
  beeUrl: string = DEFAULT_BEE_NODE_URL,
): Promise<void> {
  await new Bee(beeUrl).topUpBatch(strip0x(batchId), amount)
}

/**
 * Increase an existing batch's depth, growing its capacity. The node must own
 * the batch; rejects with the node's error otherwise. Dilution alone divides
 * the remaining lifespan across the larger capacity — callers top up too when
 * preserving the lifespan.
 */
export async function diluteStamp(
  batchId: string,
  depth: number,
  beeUrl: string = DEFAULT_BEE_NODE_URL,
): Promise<void> {
  await new Bee(beeUrl).diluteBatch(strip0x(batchId), depth)
}

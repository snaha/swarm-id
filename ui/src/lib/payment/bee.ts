// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey, Utils } from '@ethersphere/bee-js'
import { DEFAULT_BEE_NODE_URL } from '@snaha/swarm-id'

import type { NewStamp } from '$lib/payment/purchase'

/** A postage batch as returned by Bee's `GET /stamps/{id}`. */
interface NodeStamp {
  batchID: string
  depth: number
  amount: string
  bucketDepth: number
  blockNumber: number
  immutableFlag: boolean
  utilization: number
  usable: boolean
  exists: boolean
  batchTTL?: number
}

/** Strip a 0x prefix from a batch id for use in Bee URL paths. */
function bareBatchId(batchId: string): string {
  return batchId.startsWith('0x') ? batchId.slice(2) : batchId
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  return text || `HTTP ${response.status}`
}

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
  const base = beeUrl.replace(/\/$/, '')
  let stamp: NodeStamp
  try {
    const response = await fetch(`${base}/stamps/${bareBatchId(batchId)}`)
    if (!response.ok) {
      return undefined
    }
    stamp = (await response.json()) as NodeStamp
  } catch {
    return undefined
  }

  return {
    batchID: new BatchId(bareBatchId(batchId)),
    name,
    signerKey,
    depth: stamp.depth,
    amount: BigInt(stamp.amount),
    bucketDepth: stamp.bucketDepth,
    blockNumber: stamp.blockNumber,
    immutableFlag: stamp.immutableFlag,
    // Node reports raw bucket utilization; store the 0–1 fraction the UI reads.
    utilization: Utils.getStampUsage(stamp.utilization, stamp.depth, stamp.bucketDepth),
    usable: stamp.usable,
    exists: stamp.exists,
    batchTTL: stamp.batchTTL,
  }
}

/**
 * Add funds to an existing batch (`PATCH /stamps/topup`), extending its
 * lifespan. The node must own the batch; rejects with the node's error
 * otherwise. `amount` is the additional per-chunk balance in PLUR.
 */
export async function topUpStamp(
  batchId: string,
  amount: bigint,
  beeUrl: string = DEFAULT_BEE_NODE_URL,
): Promise<void> {
  const base = beeUrl.replace(/\/$/, '')
  const response = await fetch(`${base}/stamps/topup/${bareBatchId(batchId)}/${amount}`, {
    method: 'PATCH',
  })
  if (!response.ok) {
    throw new Error(await readError(response))
  }
}

/**
 * Increase an existing batch's depth (`PATCH /stamps/dilute`), growing its
 * capacity. The node must own the batch; rejects with the node's error
 * otherwise. Dilution alone divides the remaining lifespan across the larger
 * capacity — callers top up too when preserving the lifespan.
 */
export async function diluteStamp(
  batchId: string,
  depth: number,
  beeUrl: string = DEFAULT_BEE_NODE_URL,
): Promise<void> {
  const base = beeUrl.replace(/\/$/, '')
  const response = await fetch(`${base}/stamps/dilute/${bareBatchId(batchId)}/${depth}`, {
    method: 'PATCH',
  })
  if (!response.ok) {
    throw new Error(await readError(response))
  }
}

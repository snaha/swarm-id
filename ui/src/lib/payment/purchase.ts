// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import { type PostageStamp, derivePostageSignerKey } from '@snaha/swarm-id'

import { strip0x } from '$lib/crypto/hex'
import { privateKeyFromEntropy } from '$lib/crypto/mnemonic'
import type { BatchEvent } from '$lib/payment/multichain-widget'

/** Bee's standard bucket depth; a batch's stamp utilization is measured against it. */
const BUCKET_DEPTH = 16

/** A freshly built stamp, ready for `account.addStamp` (which fills in `createdAt`). */
export type NewStamp = Omit<PostageStamp, 'createdAt' | 'deletedAt'>

/** The batch fields a dilute / top-up changes, applied via `account.updateStamp`. */
export type StampUpdate = Partial<Pick<PostageStamp, 'depth' | 'amount' | 'batchTTL'>>

export interface PostageSigner {
  /** Postage signer key — owns and stamps the batch. */
  signerKey: PrivateKey
  /** 0x-prefixed batch-owner address derived from the signer key. */
  destination: string
}

/**
 * Derive the account's deterministic postage signer and batch-owner address.
 * The seed (entropy) is the only input, so the same account always yields the
 * same batch owner — required for recovery and multi-device. Mirrors the legacy
 * UI: a dedicated postage key (not the account's master key) owns the batch, so
 * it can be shared with the node for stamping without exposing the master key.
 */
export async function derivePostageSigner(entropy: Uint8Array): Promise<PostageSigner> {
  // `derivePostageSignerKey` HMACs the master key as raw hex bytes, so strip the
  // 0x the ethers private key carries.
  const masterKey = strip0x(privateKeyFromEntropy(entropy))
  const signerKey = new PrivateKey(await derivePostageSignerKey(masterKey))
  const destination = `0x${signerKey.publicKey().address().toHex()}`
  return { signerKey, destination }
}

/** Parse the widget's block number (hex `0x…` or decimal) into a finite integer. */
export function parseBlockNumber(value: string): number {
  const parsed = value.startsWith('0x') ? Number.parseInt(value.slice(2), 16) : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Build a stamp record from a completed widget purchase. */
export function stampFromBatch(
  batch: BatchEvent,
  signerKey: PrivateKey,
  name: string,
  batchTTL?: number,
): NewStamp {
  return {
    batchID: new BatchId(batch.batchId),
    name,
    signerKey,
    depth: batch.depth,
    amount: BigInt(batch.amount),
    bucketDepth: BUCKET_DEPTH,
    blockNumber: parseBlockNumber(batch.blockNumber),
    immutableFlag: false,
    utilization: 0,
    usable: true,
    exists: true,
    batchTTL,
  }
}

/**
 * The batch patch for a top-up that adds `addedSeconds` of lifespan, funded by
 * `topUpAmount` PLUR per chunk. Mirrors the node's outcome so the UI reflects
 * the extension immediately.
 */
export function extendedStamp(
  stamp: PostageStamp,
  addedSeconds: number,
  topUpAmount: bigint,
): StampUpdate {
  return {
    amount: stamp.amount + topUpAmount,
    batchTTL: (stamp.batchTTL ?? 0) + addedSeconds,
  }
}

/**
 * Plan a dilution to `newDepth`. Dilution spreads the fixed deposit across
 * 2^(Δdepth) more chunks, dividing the per-chunk balance — and so the remaining
 * lifespan — by that factor. When `keepLifespan` is set, returns the extra
 * per-chunk `topUpAmount` that restores the original balance (and lifespan);
 * otherwise the lifespan shrinks and `topUpAmount` is 0.
 */
export function dilutedStamp(
  stamp: PostageStamp,
  newDepth: number,
  keepLifespan: boolean,
): { update: StampUpdate; topUpAmount: bigint } {
  const factor = 2n ** BigInt(Math.max(0, newDepth - stamp.depth))
  const oldAmount = stamp.amount
  const dilutedAmount = oldAmount / factor

  if (keepLifespan) {
    return {
      update: { depth: newDepth, amount: oldAmount },
      topUpAmount: oldAmount - dilutedAmount,
    }
  }

  return {
    update: {
      depth: newDepth,
      amount: dilutedAmount,
      batchTTL:
        stamp.batchTTL === undefined ? undefined : Math.floor(stamp.batchTTL / Number(factor)),
    },
    topUpAmount: 0n,
  }
}

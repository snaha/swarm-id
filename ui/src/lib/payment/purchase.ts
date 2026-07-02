// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey, Utils } from '@ethersphere/bee-js'
import {
  BUCKET_DEPTH,
  GNOSIS_BLOCK_TIME,
  type PostageStamp,
  calculateStampAmountForDays,
  deriveAccountDerivationKey,
  derivePostageSignerKey,
} from '@snaha/swarm-id'

import { strip0x } from '$lib/crypto/hex'
import { privateKeyFromEntropy } from '$lib/crypto/mnemonic'
import { SECONDS_PER_DAY } from '$lib/drives'
import type { BatchEvent } from '$lib/payment/multichain-widget'

/** Cost estimates shown in the drive dialogs round to this many significant digits. */
const COST_SIGNIFICANT_DIGITS = 4

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
 * UI and /dev: the signer hangs off the account DERIVATION key (the same
 * `master → derivation-key → postage-signer` chain as
 * `derivePostageSignerKey(account.derivationKey)`), so batches bought anywhere
 * are owned by the same key, and the master key is never shared for stamping.
 */
export async function derivePostageSigner(entropy: Uint8Array): Promise<PostageSigner> {
  // The derivation functions HMAC their input as raw hex bytes, so strip the
  // 0x the ethers private key carries.
  const masterKey = strip0x(privateKeyFromEntropy(entropy))
  const derivationKey = await deriveAccountDerivationKey(masterKey)
  const signerKey = new PrivateKey(await derivePostageSignerKey(derivationKey))
  const destination = signerKey.publicKey().address().toChecksum()
  return { signerKey, destination }
}

/**
 * PLUR per chunk funding `seconds` of lifespan at the chain's current price.
 * Rounds up to whole days (Bee enforces a 24h floor, and rounding a fractional
 * day down would under-fund the target lifespan).
 */
export function stampAmountForSeconds(pricePerBlock: bigint, seconds: number): bigint {
  return calculateStampAmountForDays(
    pricePerBlock,
    Math.max(1, Math.ceil(seconds / SECONDS_PER_DAY)),
  )
}

/**
 * The BZZ cost of a batch of `depth` funded with `amount` PLUR per chunk,
 * rendered to the dialogs' significant digits — or `undefined` when the inputs
 * can't be priced (non-positive amount, depth out of range).
 */
export function stampCostBzz(depth: number, amount: bigint): string | undefined {
  if (amount <= 0n) {
    return undefined
  }
  try {
    return Utils.getStampCost(depth, amount).toSignificantDigits(COST_SIGNIFICANT_DIGITS)
  } catch {
    return undefined
  }
}

/**
 * Bee's lifespan estimate (seconds) for a per-chunk balance of `amount` PLUR at
 * `pricePerBlock` PLUR per chunk per block — the inverse of
 * {@link stampAmountForSeconds}: blocks funded × block time.
 */
export function stampTtlSeconds(amount: bigint, pricePerBlock: bigint): number | undefined {
  if (amount <= 0n || pricePerBlock <= 0n) {
    return undefined
  }
  return Number(amount / pricePerBlock) * GNOSIS_BLOCK_TIME
}

/** Parse the widget's block number (hex `0x…` or decimal) into an integer; `0`
 * for garbage or non-integer input (downstream stores it as a block height). */
export function parseBlockNumber(value: string): number {
  const parsed = value.startsWith('0x') ? Number.parseInt(value.slice(2), 16) : Number(value)
  return Number.isInteger(parsed) ? parsed : 0
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
 * the extension immediately. `remainingTtl` is the drive's CURRENT remaining
 * lifespan (the aged value from `remainingLifespanSeconds`, not the stored
 * snapshot) — `account.updateStamp` re-anchors the TTL's measurement instant,
 * so patching from a stale snapshot would resurrect already-elapsed time.
 */
export function extendedStamp(
  stamp: PostageStamp,
  addedSeconds: number,
  topUpAmount: bigint,
  remainingTtl: number | undefined,
): StampUpdate {
  return {
    amount: stamp.amount + topUpAmount,
    batchTTL: Math.max(0, remainingTtl ?? 0) + addedSeconds,
  }
}

/** A dilution plan: the node operations' outcomes as local-record patches. */
export interface DilutionPlan {
  /** Batch state right after the dilute lands (per-chunk balance divided). */
  afterDilute: StampUpdate
  /** Extra per-chunk PLUR restoring the original lifespan; `0n` when shrinking. */
  topUpAmount: bigint
  /** Batch state after the compensating top-up (equals `afterDilute` when none). */
  afterTopUp: StampUpdate
}

/**
 * Plan a dilution to `newDepth`. Dilution spreads the fixed deposit across
 * 2^(Δdepth) more chunks, dividing the per-chunk balance — and so the remaining
 * lifespan — by that factor. When `keepLifespan` is set, `topUpAmount` is the
 * extra per-chunk balance that restores the original lifespan; otherwise it is
 * `0n` and the lifespan shrinks. `remainingTtl` is the drive's CURRENT remaining
 * lifespan (see {@link extendedStamp}). The two node calls are separate
 * transactions, so the plan exposes both intermediate states — a failed top-up
 * leaves the batch at `afterDilute`, which the caller must record before
 * retrying the top-up alone.
 */
export function dilutedStamp(
  stamp: PostageStamp,
  newDepth: number,
  keepLifespan: boolean,
  remainingTtl: number | undefined,
): DilutionPlan {
  const factor = 2n ** BigInt(Math.max(0, newDepth - stamp.depth))
  const oldAmount = stamp.amount
  const dilutedAmount = oldAmount / factor
  const dilutedTtl =
    remainingTtl === undefined ? undefined : Math.floor(Math.max(0, remainingTtl) / Number(factor))

  const afterDilute: StampUpdate = {
    depth: newDepth,
    amount: dilutedAmount,
    batchTTL: dilutedTtl,
  }

  if (!keepLifespan) {
    return { afterDilute, topUpAmount: 0n, afterTopUp: afterDilute }
  }

  return {
    afterDilute,
    topUpAmount: oldAmount - dilutedAmount,
    afterTopUp: {
      depth: newDepth,
      amount: oldAmount,
      batchTTL: remainingTtl === undefined ? undefined : Math.max(0, remainingTtl),
    },
  }
}

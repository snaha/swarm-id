// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { PrivateKey, Utils } from '@ethersphere/bee-js'
import {
  GNOSIS_BLOCK_TIME,
  type PostageStamp,
  calculateStampAmountForDays,
  derivePostageSignerKey,
} from '@snaha/swarm-id'

import { SECONDS_PER_DAY } from '$lib/drives'

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
 * Derive the account's deterministic postage signer and batch-owner address from
 * its (plaintext) derivation key. The signer hangs off the account DERIVATION
 * key (the `derivation-key → postage-signer` leg of the master chain), so the
 * same account always yields the same batch owner — required for recovery and
 * multi-device — and no seed unlock is needed (the derivation key is already in
 * the stored account, and the resulting signer is persisted in the stamp anyway).
 */
export async function derivePostageSigner(derivationKey: string): Promise<PostageSigner> {
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

/** Seconds of lifespan a per-chunk balance funds at `lastPrice` (PLUR per
 * chunk per block); undefined on a zero price (dev chains without an oracle —
 * no finite expiry to render). */
export function ttlSecondsFor(perChunk: bigint, lastPrice: bigint): number | undefined {
  if (perChunk <= 0n) {
    return 0
  }
  if (lastPrice <= 0n) {
    return undefined
  }
  return Number(perChunk / lastPrice) * GNOSIS_BLOCK_TIME
}

/**
 * An on-chain resize plan. Order is contract-mandated: the compensating top-up
 * runs FIRST (at the old depth), then `increaseDepth` — the contract checks
 * the post-dilution per-chunk balance against the ~24h minimum BEFORE any
 * compensation, so the node-era dilute-then-top-up order reverts exactly in
 * the common keep-lifespan case.
 */
export interface ResizePlan {
  newDepth: number
  /** Extra per-chunk PLUR topped up at the OLD depth, before the increase. */
  topUpAmount: bigint
  /** True when the contract's minimum-balance floor forced `topUpAmount`
   * above what the lifespan goal alone required. */
  clampedToFloor: boolean
  /** Record patch once the top-up lands: depth unchanged, lifespan grown —
   * the benign intermediate state a failed increase leaves behind. */
  afterTopUp: StampUpdate
  /** Final record patch once increaseDepth lands. */
  afterDilute: StampUpdate
}

/**
 * Plan a resize to `newDepth` from the batch's LIVE remaining per-chunk
 * balance (chain truth — never the stored `stamp.amount`, which is a stale
 * snapshot that would over- or under-top). With `keepLifespan`, the top-up
 * restores the post-dilution balance to the current one (cost = remaining ×
 * (2^Δ − 1) per chunk, identical in total to the old dilute-first model).
 * Either way the plan is raised to clear `minimumInitialBalancePerChunk`
 * after division — a plan below the floor would be a guaranteed revert.
 */
export function resizePlan(
  currentDepth: number,
  newDepth: number,
  keepLifespan: boolean,
  liveRemaining: bigint,
  minimumInitialBalancePerChunk: bigint,
  lastPrice: bigint,
): ResizePlan {
  const factor = 2n ** BigInt(Math.max(0, newDepth - currentDepth))
  const lifespanTopUp = keepLifespan ? liveRemaining * (factor - 1n) : 0n

  // increaseDepth requires (remaining + topUp) / factor >= minimum.
  const floorTarget = minimumInitialBalancePerChunk * factor
  const clampedToFloor = liveRemaining + lifespanTopUp < floorTarget
  const topUpAmount = clampedToFloor ? floorTarget - liveRemaining : lifespanTopUp

  const preDilute = liveRemaining + topUpAmount
  const postDilute = preDilute / factor
  return {
    newDepth,
    topUpAmount,
    clampedToFloor,
    afterTopUp: {
      amount: preDilute,
      batchTTL: ttlSecondsFor(preDilute, lastPrice),
    },
    afterDilute: {
      depth: newDepth,
      amount: postDilute,
      batchTTL: ttlSecondsFor(postDilute, lastPrice),
    },
  }
}

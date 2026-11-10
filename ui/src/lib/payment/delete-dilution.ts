// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * What deleting an account does to each of its drives on chain.
 *
 * A postage batch cannot be cancelled and its balance cannot be withdrawn, so
 * the closest thing to deleting a drive is to make it expire soon: raise its
 * depth until the per-chunk balance is spread as thin as the contract allows.
 * `increaseDepth` halves the remaining balance per step and refuses a result
 * below `minimumInitialBalancePerChunk` (~1 day of storage), so the plan takes
 * as many whole steps as stay above it and the drive lapses within about a
 * day or two. The data is not erased by this; it stops being paid for.
 */
import { FLOOR_MARGIN_BLOCKS } from '$lib/payment/purchase'

/** A batch as the chain describes it, read just before planning. */
export interface DilutionChainState {
  depth: number
  /** Live per-chunk balance in PLUR. */
  remaining: bigint
  /** The batch owner, the only key `increaseDepth` accepts. */
  owner: string
  immutable: boolean
}

export interface DilutionInput {
  /** Undefined when the chain no longer has the batch. */
  chain: DilutionChainState | undefined
  /** The account's postage signer address. */
  signerAddress: string
  minimumBalancePerChunk: bigint
  /** PLUR per chunk per block, for the decay margin. */
  lastPrice: bigint
  /** The user turned "Keep data" on for this drive. */
  keep: boolean
}

/**
 * Why a drive is left as it is. `expires-soon` covers a drive with no whole
 * step left to take, which includes one a previous attempt already diluted —
 * the reason a retried deletion sends nothing twice.
 */
export type DilutionSkipReason = 'kept' | 'expires-soon' | 'not-owned' | 'immutable' | 'expired'

export type DilutionPlan = { targetDepth: number } | { skip: DilutionSkipReason }

/**
 * Plan one drive: the depth to raise it to, or why not.
 *
 * The step count k is the largest with `remaining >> k` still at or above the
 * floor, so the balance lands in [floor, 2·floor). The floor is the contract's
 * minimum plus `FLOOR_MARGIN_BLOCKS` of decay, for the reason `resizePlan`
 * keeps that margin: the contract measures the balance when the transaction
 * mines, and a plan that meets the minimum exactly reverts a few blocks later.
 */
export function planDeleteDilution(input: DilutionInput): DilutionPlan {
  const { chain, keep } = input
  if (keep) {
    return { skip: 'kept' }
  }
  if (!chain || chain.remaining <= 0n) {
    return { skip: 'expired' }
  }
  if (chain.owner.toLowerCase() !== input.signerAddress.toLowerCase()) {
    return { skip: 'not-owned' }
  }
  if (chain.immutable) {
    return { skip: 'immutable' }
  }
  const margined = input.minimumBalancePerChunk + input.lastPrice * FLOOR_MARGIN_BLOCKS
  // At least one PLUR: a zero floor (a chain with no price yet) is met by every
  // balance, and the halving would never stop.
  const floor = margined > 0n ? margined : 1n
  let steps = 0
  while (chain.remaining >> BigInt(steps + 1) >= floor) {
    steps++
  }
  if (steps < 1) {
    return { skip: 'expires-soon' }
  }
  return { targetDepth: chain.depth + steps }
}

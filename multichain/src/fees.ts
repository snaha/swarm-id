// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * What a write offers to pay, in the two shapes this package sends.
 *
 * The bundled EIP-7702 transaction prices itself in EIP-1559 fields, a cap and
 * a tip, because a type-4 transaction has no other way to. Every other write is
 * legacy and sends a single `gasPrice`, one number that IS the whole price and
 * carries its tip implicitly as whatever is left above the base fee.
 *
 * One policy covers both, because both fail the same way: an offer whose tip
 * comes to nothing is refused by the node or never included. A zero
 * `maxPriorityFeePerGas` gets there outright; a legacy price set at exactly
 * what `eth_gasPrice` quoted gets there as soon as the base fee rises to meet
 * it. So neither shape ever offers a tip below {@link MIN_PRIORITY_FEE_WEI}, and a
 * retry always bids a bump above the offer the node refused, never merely a
 * fresh quote, which can be the very number just refused, or lower.
 *
 * Split out and pure because it is the part worth testing.
 */

/**
 * The smallest tip we will offer, whatever the endpoint suggests.
 *
 * A node is free to answer `eth_maxPriorityFeePerGas` with 0 — an idle mempool
 * has nothing to outbid, and the endpoint in the reported failure effectively
 * did — but Gnosis validators will not include a transaction on those terms.
 * A floor is what stops an honest answer from producing a dead transaction.
 *
 * 1 gwei against `BUNDLE_GAS` is under 0.0013 xDAI, so the cost of being wrong
 * in this direction is a fraction of a cent, and the cost of being wrong in the
 * other is a purchase that hangs until it is given up on.
 */
export const MIN_PRIORITY_FEE_WEI = 1_000_000_000n

/** Eighths added to a refused offer on retry — the usual replacement bump, 12.5%. */
const BUMP_EIGHTHS = 1n
const EIGHTHS = 8n

export interface FeeFields {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

function bumped(refused: bigint): bigint {
  return (refused * (EIGHTHS + BUMP_EIGHTHS)) / EIGHTHS
}

/**
 * The `maxFeePerGas` / `maxPriorityFeePerGas` for one send.
 *
 * @param gasPrice what `eth_gasPrice` answered — base fee plus whatever the
 *   endpoint thinks is going rate
 * @param suggestedTip what `eth_maxPriorityFeePerGas` answered, floored below
 * @param refused the offer the node just turned down, on a retry. The next one
 *   is at least a bump above it in BOTH fields, whatever the fresh quote says:
 *   a tip fetch that fails answers 0, and a rotation onto a degraded endpoint
 *   quotes low, and a retry that bids under the refused number is the same
 *   transaction again with worse odds.
 */
export function bundleFeeFields(
  gasPrice: bigint,
  suggestedTip: bigint,
  refused?: FeeFields,
): FeeFields {
  const quotedTip = max(suggestedTip, MIN_PRIORITY_FEE_WEI)
  const maxPriorityFeePerGas = refused
    ? max(quotedTip, bumped(refused.maxPriorityFeePerGas))
    : quotedTip
  // The cap has to leave room for the base fee UNDER the tip, or the
  // effective tip is capped back down to `maxFee - baseFee` and we are where
  // we started. `gasPrice` already covers the base fee, so the tip goes on
  // top of it rather than inside it.
  const quotedCap = gasPrice + maxPriorityFeePerGas
  return {
    maxPriorityFeePerGas,
    maxFeePerGas: refused
      ? max(quotedCap, bumped(refused.maxFeePerGas))
      : quotedCap,
  }
}

/**
 * The `gasPrice` for one legacy send.
 *
 * The floor goes ON TOP of the quote rather than replacing it: `eth_gasPrice`
 * is the base fee plus the node's own tip guess, which on Gnosis is a few wei,
 * so a base fee that rises by that much between quote and inclusion leaves no
 * tip at all — a 12-wei quote meets a 12-wei base fee within a block.
 * With 1 gwei above the quote, no plausible base-fee move between the two eats
 * the tip, and it costs about 0.0002 xDAI for a swap, the same tip the bundle
 * already pays.
 *
 * @param quoted what `eth_gasPrice` answered for this attempt
 * @param refused the price the node just turned down, on a retry. The next
 *   offer is at least a bump above it, for the same reasons as
 *   {@link bundleFeeFields}: a fresh quote can come in lower, and re-bidding
 *   the refused number only waits for the network to move.
 */
export function legacyGasPrice(quoted: bigint, refused?: bigint): bigint {
  const offer = quoted + MIN_PRIORITY_FEE_WEI
  return refused === undefined ? offer : max(offer, bumped(refused))
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * What a bundled EIP-7702 transaction offers to pay (#618).
 *
 * Split out and pure because it is the part worth testing: the bundled path is
 * the only one in this package that prices itself in EIP-1559 fields. Every
 * other write sends a legacy `gasPrice`, one number that IS the whole price and
 * carries its tip implicitly. Splitting it and leaving the tip at zero produced
 * transactions no validator would include — `maxPriorityFeePerGas: 0` with a
 * 13-wei cap, refused as `FeeTooLow` on Gnosis mainnet.
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

/** Eighths added to the tip per retry — the usual replacement bump, 12.5%. */
const BUMP_EIGHTHS_PER_ATTEMPT = 1n
const EIGHTHS = 8n

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

/**
 * The `maxFeePerGas` / `maxPriorityFeePerGas` for one send.
 *
 * @param gasPrice what `eth_gasPrice` answered — base fee plus whatever the
 *   endpoint thinks is going rate
 * @param suggestedTip what `eth_maxPriorityFeePerGas` answered, floored below
 * @param attempt 0 for the first send; each retry raises the offer, because a
 *   retry that repeats a refused number is the same transaction again
 */
export function bundleFeeFields(
  gasPrice: bigint,
  suggestedTip: bigint,
  attempt: number = 0,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const floored = max(suggestedTip, MIN_PRIORITY_FEE_WEI)
  const bumps = BUMP_EIGHTHS_PER_ATTEMPT * BigInt(Math.max(attempt, 0))
  const maxPriorityFeePerGas = (floored * (EIGHTHS + bumps)) / EIGHTHS
  return {
    maxPriorityFeePerGas,
    // The cap has to leave room for the base fee UNDER the tip, or the
    // effective tip is capped back down to `maxFee - baseFee` and we are where
    // we started. `gasPrice` already covers the base fee, so the tip goes on
    // top of it rather than inside it.
    maxFeePerGas: gasPrice + maxPriorityFeePerGas,
  }
}

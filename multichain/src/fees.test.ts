// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * What a write offers to pay, in both shapes it can take.
 *
 * The failures these exist for, both on Gnosis mainnet: a bundled purchase was
 * signed with `maxPriorityFeePerGas: 0` and `maxFeePerGas: 13` wei, so no
 * validator would ever include it (#618); and a legacy swap was signed at the
 * 12 wei `eth_gasPrice` quoted, in the block where the base fee rose from 11 to
 * 12 — a tip of nothing, refused as `transaction underpriced`.
 */
import { describe, expect, it } from "vitest"
import { MIN_PRIORITY_FEE_WEI, bundleFeeFields, legacyGasPrice } from "./fees"

/** What `eth_gasPrice` answered on the endpoint that produced the 13-wei tx. */
const REPORTED_GAS_PRICE = 13n
/** What it answered for the refused swap: base fee 11 wei plus a 1-wei guess. */
const SWAP_GAS_PRICE = 12n
/** The base fee of the block the swap was refused from. */
const RISEN_BASE_FEE = 13n
const GWEI = 1_000_000_000n

describe("bundleFeeFields", () => {
  // The exact case from the report: a node suggesting nothing, and a gas price
  // far below what any validator will take.
  it("never offers a zero tip, however little the node suggests", () => {
    const fees = bundleFeeFields(REPORTED_GAS_PRICE, 0n)
    expect(fees.maxPriorityFeePerGas).toBe(MIN_PRIORITY_FEE_WEI)
    expect(fees.maxPriorityFeePerGas).toBeGreaterThan(0n)
  })

  // A cap below the tip is the same transaction by another route: the
  // effective tip is capped at `maxFee - baseFee`, so it would still be zero.
  it("keeps the cap above the tip it offers", () => {
    const fees = bundleFeeFields(REPORTED_GAS_PRICE, 0n)
    expect(fees.maxFeePerGas).toBeGreaterThan(fees.maxPriorityFeePerGas)
  })

  it("takes the node's suggestion when it exceeds the floor", () => {
    const fees = bundleFeeFields(2n * GWEI, 3n * GWEI)
    expect(fees.maxPriorityFeePerGas).toBe(3n * GWEI)
  })

  it("leaves room for the base fee on top of the tip", () => {
    const fees = bundleFeeFields(2n * GWEI, 1n * GWEI)
    expect(fees.maxFeePerGas).toBe(2n * GWEI + fees.maxPriorityFeePerGas)
  })

  // `withFeeTooLowRetry` used to re-send byte-identical transactions. A retry
  // has to bid ABOVE what was refused — and the refused offer is what it
  // bids against, not a fresh quote: a tip fetch that fails answers 0, and a
  // provider rotation can land on a degraded endpoint, so a re-quote can be
  // lower than the attempt the node just turned down.
  it("bids above the refused offer even when the fresh quote dropped", () => {
    const refused = bundleFeeFields(2n * GWEI, 3n * GWEI)
    const retry = bundleFeeFields(REPORTED_GAS_PRICE, 0n, refused)
    expect(retry.maxPriorityFeePerGas).toBeGreaterThan(
      refused.maxPriorityFeePerGas,
    )
    expect(retry.maxFeePerGas).toBeGreaterThan(refused.maxFeePerGas)
  })

  it("takes the fresh quote when it rose past the bump", () => {
    const refused = bundleFeeFields(1n * GWEI, 1n * GWEI)
    const retry = bundleFeeFields(5n * GWEI, 4n * GWEI, refused)
    expect(retry.maxPriorityFeePerGas).toBe(4n * GWEI)
    expect(retry.maxFeePerGas).toBe(9n * GWEI)
  })

  it("keeps rising across retries", () => {
    const first = bundleFeeFields(REPORTED_GAS_PRICE, 0n)
    const second = bundleFeeFields(REPORTED_GAS_PRICE, 0n, first)
    const third = bundleFeeFields(REPORTED_GAS_PRICE, 0n, second)
    expect(second.maxPriorityFeePerGas).toBeGreaterThan(
      first.maxPriorityFeePerGas,
    )
    expect(third.maxPriorityFeePerGas).toBeGreaterThan(
      second.maxPriorityFeePerGas,
    )
  })
})

describe("legacyGasPrice", () => {
  // The incident: a legacy `gasPrice` is the whole price, and its tip is
  // whatever is left above the base fee. Sent at the quote, a base fee that
  // rises by the quote's own tip guess leaves nothing.
  it("leaves a tip when the base fee rises past the quote", () => {
    const offer = legacyGasPrice(SWAP_GAS_PRICE)
    expect(offer).toBeGreaterThanOrEqual(SWAP_GAS_PRICE + MIN_PRIORITY_FEE_WEI)
    expect(offer - RISEN_BASE_FEE).toBeGreaterThan(0n)
  })

  // As for the bundle: a rotation onto a degraded endpoint can quote lower
  // than the attempt the node just turned down, and a retry that bids under
  // the refused number is the same transaction again with worse odds.
  it("bids above the refused offer even when the fresh quote dropped", () => {
    const refused = legacyGasPrice(5n * GWEI)
    const retry = legacyGasPrice(SWAP_GAS_PRICE, refused)
    expect(retry).toBeGreaterThan(refused)
  })

  it("takes the fresh quote when it rose past the bump", () => {
    const refused = legacyGasPrice(SWAP_GAS_PRICE)
    const retry = legacyGasPrice(5n * GWEI, refused)
    expect(retry).toBe(5n * GWEI + MIN_PRIORITY_FEE_WEI)
  })

  it("keeps rising across retries", () => {
    const first = legacyGasPrice(SWAP_GAS_PRICE)
    const second = legacyGasPrice(SWAP_GAS_PRICE, first)
    const third = legacyGasPrice(SWAP_GAS_PRICE, second)
    expect(second).toBeGreaterThan(first)
    expect(third).toBeGreaterThan(second)
  })
})

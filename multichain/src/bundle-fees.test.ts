// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The fee fields of a bundled EIP-7702 transaction (#618).
 *
 * The failure these exist for: a purchase on Gnosis mainnet was signed with
 * `maxPriorityFeePerGas: 0` and `maxFeePerGas: 13` wei, so no validator would
 * ever include it. The node answered `FeeTooLow` and the retry loop gave up.
 */
import { describe, expect, it } from "vitest"
import { MIN_PRIORITY_FEE_WEI, bundleFeeFields } from "./bundle-fees"

/** What `eth_gasPrice` answered on the endpoint that produced the 13-wei tx. */
const REPORTED_GAS_PRICE = 13n
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

  // `withFeeTooLowRetry` used to re-send byte-identical transactions; the
  // attempt index is what lets a retry actually differ from what was refused.
  it("raises the offer on each retry", () => {
    const first = bundleFeeFields(REPORTED_GAS_PRICE, 0n, 0)
    const second = bundleFeeFields(REPORTED_GAS_PRICE, 0n, 1)
    const third = bundleFeeFields(REPORTED_GAS_PRICE, 0n, 2)

    expect(second.maxPriorityFeePerGas).toBeGreaterThan(
      first.maxPriorityFeePerGas,
    )
    expect(third.maxPriorityFeePerGas).toBeGreaterThan(
      second.maxPriorityFeePerGas,
    )
    expect(second.maxFeePerGas).toBeGreaterThan(first.maxFeePerGas)
  })

  it("defaults to the first attempt", () => {
    expect(bundleFeeFields(REPORTED_GAS_PRICE, 0n)).toEqual(
      bundleFeeFields(REPORTED_GAS_PRICE, 0n, 0),
    )
  })
})

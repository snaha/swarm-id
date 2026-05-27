// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { calculateStampAmountForDays, fetchChainState } from "./ttl"

describe("calculateStampAmountForDays", () => {
  // bee-compose default PriceOracle floor: 24_000 PLUR/chunk/block
  //   24_000 * 17_280 blocks/day = 414_720_000 PLUR/chunk for 24h
  // This is the exact "minimum amount" Bee reports in the
  // "insufficient validity" error on POST /stamps.
  const BEE_COMPOSE_PRICE = 24_000n
  const BEE_COMPOSE_24H_MIN = 414_720_000n

  it("matches Bee's reported 24h minimum at the bee-compose price", () => {
    expect(calculateStampAmountForDays(BEE_COMPOSE_PRICE, 1)).toBe(
      BEE_COMPOSE_24H_MIN,
    )
  })

  it("scales linearly with days", () => {
    expect(calculateStampAmountForDays(BEE_COMPOSE_PRICE, 7)).toBe(
      7n * BEE_COMPOSE_24H_MIN,
    )
  })

  it("returns 0n for non-integer, zero, or negative days", () => {
    expect(calculateStampAmountForDays(BEE_COMPOSE_PRICE, 0)).toBe(0n)
    expect(calculateStampAmountForDays(BEE_COMPOSE_PRICE, -1)).toBe(0n)
    expect(calculateStampAmountForDays(BEE_COMPOSE_PRICE, 1.5)).toBe(0n)
    expect(calculateStampAmountForDays(BEE_COMPOSE_PRICE, NaN)).toBe(0n)
  })

  it("returns 0n for non-positive price", () => {
    expect(calculateStampAmountForDays(0n, 1)).toBe(0n)
    expect(calculateStampAmountForDays(-1n, 1)).toBe(0n)
  })
})

describe("fetchChainState", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  function mockResponse(body: unknown, ok = true, status = 200): Response {
    return {
      ok,
      status,
      json: () => Promise.resolve(body),
    } as Response
  }

  it("parses block and currentPrice from /chainstate", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ block: 12_345, currentPrice: "24000" }),
    )

    const state = await fetchChainState("http://localhost:1633")

    expect(state).toEqual({ block: 12_345, currentPrice: 24_000n })
    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:1633/chainstate")
  })

  it("strips a trailing slash from the Bee URL", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ block: 1, currentPrice: "1" }))

    await fetchChainState("http://localhost:1633/")

    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:1633/chainstate")
  })

  it("throws when the response is not ok", async () => {
    fetchSpy.mockResolvedValue(mockResponse({}, false, 500))

    await expect(fetchChainState("http://localhost:1633")).rejects.toThrow(
      /500/,
    )
  })

  it("throws when currentPrice is missing", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ block: 1 }))

    await expect(fetchChainState("http://localhost:1633")).rejects.toThrow(
      /currentPrice/,
    )
  })

  it("throws when block is missing", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ currentPrice: "24000" }))

    await expect(fetchChainState("http://localhost:1633")).rejects.toThrow(
      /block/,
    )
  })
})

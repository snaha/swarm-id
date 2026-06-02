// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  calculateStampAmountForDays,
  calculateTTLSeconds,
  fetchChainState,
  fetchBatchTTL,
} from "./ttl"

const BATCH_ID =
  "b88a934e78c793bde43abcb7d2e41dc87de06ad18a747bdd672b0e32f23c687e"

function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response
}

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

describe("calculateTTLSeconds", () => {
  // Reference figures from the bug report on issue #279:
  //   amount = 13_737_600_001 PLUR (per chunk)
  //   pricePerGBPerMonth ≈ 0.7025 BZZ/GiB/month  → ≈ 15.4 days lifetime
  const ISSUE_279_AMOUNT = 13_737_600_001n
  const ISSUE_279_PRICE = 0.70253870579712
  const ISSUE_279_TTL_SECONDS_LOWER = 13 * 86_400 // 13d
  const ISSUE_279_TTL_SECONDS_UPPER = 17 * 86_400 // 17d

  it("returns a plausible lifetime for the issue #279 values", () => {
    const ttl = calculateTTLSeconds(ISSUE_279_AMOUNT, ISSUE_279_PRICE)
    expect(ttl).toBeGreaterThan(ISSUE_279_TTL_SECONDS_LOWER)
    expect(ttl).toBeLessThan(ISSUE_279_TTL_SECONDS_UPPER)
  })

  it("accepts string and number amounts equivalently to bigint", () => {
    const fromBigint = calculateTTLSeconds(ISSUE_279_AMOUNT, ISSUE_279_PRICE)
    const fromString = calculateTTLSeconds("13737600001", ISSUE_279_PRICE)
    const fromNumber = calculateTTLSeconds(13_737_600_001, ISSUE_279_PRICE)
    expect(fromString).toBe(fromBigint)
    expect(fromNumber).toBe(fromBigint)
  })

  it("returns 0 when the price is 0 (e.g. local dev chain)", () => {
    expect(calculateTTLSeconds(ISSUE_279_AMOUNT, 0)).toBe(0)
  })

  it("returns 0 when the price is negative", () => {
    expect(calculateTTLSeconds(ISSUE_279_AMOUNT, -1)).toBe(0)
  })

  it("returns 0 when the price is not finite", () => {
    expect(calculateTTLSeconds(ISSUE_279_AMOUNT, NaN)).toBe(0)
    expect(calculateTTLSeconds(ISSUE_279_AMOUNT, Infinity)).toBe(0)
  })

  it("returns 0 when the amount is 0", () => {
    expect(calculateTTLSeconds(0n, ISSUE_279_PRICE)).toBe(0)
  })

  it("returns 0 when the amount is negative", () => {
    expect(calculateTTLSeconds(-1n, ISSUE_279_PRICE)).toBe(0)
  })

  it("scales linearly with amount", () => {
    const single = calculateTTLSeconds(ISSUE_279_AMOUNT, ISSUE_279_PRICE)
    const double = calculateTTLSeconds(ISSUE_279_AMOUNT * 2n, ISSUE_279_PRICE)
    // Linear within BigInt truncation noise (well under 1%).
    expect(double).toBeGreaterThan(single * 2 - 1)
    expect(double).toBeLessThan(single * 2 + 1)
  })

  it("preserves precision past Number.MAX_SAFE_INTEGER", () => {
    // 1e18 PLUR per chunk would overflow `Number(amountBigInt) * 1e16` math.
    // BigInt path stays accurate, so the result is finite and positive.
    const huge = 1_000_000_000_000_000_000n
    const ttl = calculateTTLSeconds(huge, ISSUE_279_PRICE)
    expect(Number.isFinite(ttl)).toBe(true)
    expect(ttl).toBeGreaterThan(0)
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

  it("throws when currentPrice is a number, not a string", async () => {
    // Bee always serialises currentPrice as a string. If a non-Bee server
    // returns a JSON number, JSON.parse may have already rounded it past
    // Number.MAX_SAFE_INTEGER, so we refuse it rather than silently widening
    // a corrupted value to BigInt.
    fetchSpy.mockResolvedValue(mockResponse({ block: 1, currentPrice: 24_000 }))

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

describe("fetchBatchTTL", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("returns batchTTL from Bee /stamps/{id} response", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ batchTTL: 86400 }))

    const ttl = await fetchBatchTTL("https://bee.example.com", BATCH_ID)

    expect(ttl).toBe(86400)
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://bee.example.com/stamps/${BATCH_ID}`,
    )
  })

  it("strips a trailing slash from the Bee URL", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ batchTTL: 123 }))

    await fetchBatchTTL("https://bee.example.com/", BATCH_ID)

    expect(fetchSpy).toHaveBeenCalledWith(
      `https://bee.example.com/stamps/${BATCH_ID}`,
    )
  })

  it("returns undefined when the stamp is not found (404)", async () => {
    fetchSpy.mockResolvedValue(mockResponse({}, false, 404))

    const ttl = await fetchBatchTTL("https://bee.example.com", BATCH_ID)

    expect(ttl).toBeUndefined()
  })

  it("returns undefined when the response is missing batchTTL", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ amount: "100" }))

    const ttl = await fetchBatchTTL("https://bee.example.com", BATCH_ID)

    expect(ttl).toBeUndefined()
  })

  it("returns undefined when the response body is not an object", async () => {
    fetchSpy.mockResolvedValue(mockResponse(null))

    const ttl = await fetchBatchTTL("https://bee.example.com", BATCH_ID)

    expect(ttl).toBeUndefined()
  })

  it("returns undefined when batchTTL is not a number", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ batchTTL: "86400" }))

    const ttl = await fetchBatchTTL("https://bee.example.com", BATCH_ID)

    expect(ttl).toBeUndefined()
  })

  it("normalises negative TTL values to 0", async () => {
    // Bee returns negative batchTTL for expired stamps in some versions.
    fetchSpy.mockResolvedValue(mockResponse({ batchTTL: -1 }))

    const ttl = await fetchBatchTTL("https://bee.example.com", BATCH_ID)

    expect(ttl).toBe(0)
  })

  it("returns undefined when fetch rejects", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"))

    const ttl = await fetchBatchTTL("https://bee.example.com", BATCH_ID)

    expect(ttl).toBeUndefined()
  })

  it("returns undefined when JSON parsing fails", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error("invalid json")),
    } as unknown as Response)

    const ttl = await fetchBatchTTL("https://bee.example.com", BATCH_ID)

    expect(ttl).toBeUndefined()
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  calculateContractTTLSeconds,
  decodeBatches,
  decodeUint,
  fetchAuthoritativeBatchTTL,
  fetchBatchTTLFromContract,
  fetchOnChainBatchState,
  fetchOnChainBatchStateResult,
  resolveBatchStatus,
  POSTAGE_STAMP_CONTRACT_ADDRESS,
  resolvePostageStampContractAddress,
  type OnChainBatchState,
} from "./postage-contract"

// Real on-chain data captured for batch
// 178f3ac9741b7659c4b80e1ae80fbf5ef4975f7aceed6560712bb4d126697de0
// (the batch from issue #344) at block ~46.6M.
const BATCH_ID =
  "178f3ac9741b7659c4b80e1ae80fbf5ef4975f7aceed6560712bb4d126697de0"

const OWNER = "0xb486f0d45be037a937e92bf48ee85f63053ed61d"
const DEPTH = 21
const BUCKET_DEPTH = 16
const NORMALISED_BALANCE = 682583171899n
const LAST_UPDATED_BLOCK = 46591298n
const CURRENT_TOTAL_OUT_PAYMENT = 675749301230n
const LAST_PRICE = 59203n
// remaining = 682583171899 - 675749301230 = 6833870669
// blocks    = 6833870669 / 59203 = 115431
// seconds   = 115431 * 5 = 577155
const EXPECTED_TTL_SECONDS = 577155

/** Left-pads a value to a 32-byte (64-hex) ABI word. */
function word(value: bigint | string): string {
  const hex =
    typeof value === "bigint"
      ? value.toString(16)
      : value.replace(/^0x/, "").toLowerCase()
  return hex.padStart(64, "0")
}

// batches() returns a static tuple (address, uint8, uint8, bool, uint256, uint256).
const BATCHES_RESULT =
  "0x" +
  word(OWNER) +
  word(BigInt(DEPTH)) +
  word(BigInt(BUCKET_DEPTH)) +
  word(0n) + // immutableFlag = false
  word(NORMALISED_BALANCE) +
  word(LAST_UPDATED_BLOCK)

const OUT_PAYMENT_RESULT = "0x" + word(CURRENT_TOTAL_OUT_PAYMENT)
const LAST_PRICE_RESULT = "0x" + word(LAST_PRICE)

function batchResponse(
  results: Record<number, { result?: string; error?: { message: string } }>,
): Response {
  const body = Object.entries(results).map(([id, value]) => ({
    jsonrpc: "2.0",
    id: Number(id),
    ...value,
  }))
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response
}

const FULL_RESPONSE = {
  0: { result: BATCHES_RESULT },
  1: { result: OUT_PAYMENT_RESULT },
  2: { result: LAST_PRICE_RESULT },
}

describe("decodeBatches", () => {
  it("decodes the batches() tuple", () => {
    const batch = decodeBatches(BATCHES_RESULT)
    expect(batch.owner).toBe("0xb486f0d45be037a937e92bf48ee85f63053ed61d")
    expect(batch.depth).toBe(21)
    expect(batch.bucketDepth).toBe(16)
    expect(batch.immutableFlag).toBe(false)
    expect(batch.normalisedBalance).toBe(NORMALISED_BALANCE)
    expect(batch.lastUpdatedBlockNumber).toBe(46591298n)
  })

  it("throws when the payload is too short", () => {
    expect(() => decodeBatches("0x00")).toThrow(/length/)
  })
})

describe("decodeUint", () => {
  it("decodes a single uint256 word", () => {
    expect(decodeUint(OUT_PAYMENT_RESULT)).toBe(CURRENT_TOTAL_OUT_PAYMENT)
    expect(decodeUint(LAST_PRICE_RESULT)).toBe(LAST_PRICE)
  })

  it("throws on empty payload", () => {
    expect(() => decodeUint("0x")).toThrow()
  })
})

describe("calculateContractTTLSeconds", () => {
  const baseState: OnChainBatchState = {
    batch: {
      owner: "0xb486f0d45be037a937e92bf48ee85f63053ed61d",
      depth: 21,
      bucketDepth: 16,
      immutableFlag: false,
      normalisedBalance: NORMALISED_BALANCE,
      lastUpdatedBlockNumber: 46591298n,
    },
    currentTotalOutPayment: CURRENT_TOTAL_OUT_PAYMENT,
    lastPrice: LAST_PRICE,
  }

  it("matches the value Bee computes from the same chain state", () => {
    expect(calculateContractTTLSeconds(baseState)).toBe(EXPECTED_TTL_SECONDS)
  })

  it("returns 0 when the batch is expired (outpayment caught up)", () => {
    expect(
      calculateContractTTLSeconds({
        ...baseState,
        currentTotalOutPayment: NORMALISED_BALANCE,
      }),
    ).toBe(0)
    expect(
      calculateContractTTLSeconds({
        ...baseState,
        currentTotalOutPayment: NORMALISED_BALANCE + 1n,
      }),
    ).toBe(0)
  })

  it("returns undefined for a zero price (no finite expiry)", () => {
    expect(
      calculateContractTTLSeconds({ ...baseState, lastPrice: 0n }),
    ).toBeUndefined()
  })
})

describe("fetchOnChainBatchState", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("fetches and decodes the full batch state", async () => {
    fetchSpy.mockResolvedValue(batchResponse(FULL_RESPONSE))

    const state = await fetchOnChainBatchState("https://rpc.example", BATCH_ID)

    expect(state).toBeDefined()
    expect(state?.batch.normalisedBalance).toBe(NORMALISED_BALANCE)
    expect(state?.currentTotalOutPayment).toBe(CURRENT_TOTAL_OUT_PAYMENT)
    expect(state?.lastPrice).toBe(LAST_PRICE)
  })

  it("targets the PostageStamp contract with the batches() selector", async () => {
    fetchSpy.mockResolvedValue(batchResponse(FULL_RESPONSE))

    await fetchOnChainBatchState("https://rpc.example", BATCH_ID)

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    )
    expect(body).toHaveLength(3)
    expect(body[0].method).toBe("eth_call")
    expect(body[0].params[0].to).toBe(POSTAGE_STAMP_CONTRACT_ADDRESS)
    expect(body[0].params[0].data).toBe(`0xc81e25ab${BATCH_ID}`)
  })

  it("targets a custom contract address when provided (local dev chain)", async () => {
    fetchSpy.mockResolvedValue(batchResponse(FULL_RESPONSE))
    const LOCAL_CONTRACT = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512"

    await fetchOnChainBatchState(
      "https://rpc.example",
      BATCH_ID,
      LOCAL_CONTRACT,
    )

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    )
    expect(body).toHaveLength(3)
    for (const call of body) {
      expect(call.params[0].to).toBe(LOCAL_CONTRACT)
    }
  })

  it("accepts a 0x-prefixed batch ID", async () => {
    fetchSpy.mockResolvedValue(batchResponse(FULL_RESPONSE))

    const state = await fetchOnChainBatchState(
      "https://rpc.example",
      `0x${BATCH_ID}`,
    )

    expect(state).toBeDefined()
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    )
    expect(body[0].params[0].data).toBe(`0xc81e25ab${BATCH_ID}`)
  })

  it("matches responses by id even when returned out of order", async () => {
    fetchSpy.mockResolvedValue(
      batchResponse({
        2: { result: LAST_PRICE_RESULT },
        0: { result: BATCHES_RESULT },
        1: { result: OUT_PAYMENT_RESULT },
      }),
    )

    const state = await fetchOnChainBatchState("https://rpc.example", BATCH_ID)

    expect(state?.lastPrice).toBe(LAST_PRICE)
    expect(state?.currentTotalOutPayment).toBe(CURRENT_TOTAL_OUT_PAYMENT)
  })

  it("returns undefined for an unknown batch (zero owner)", async () => {
    const zeroTuple = "0x" + "0".repeat(64 * 6)
    fetchSpy.mockResolvedValue(
      batchResponse({
        0: { result: zeroTuple },
        1: { result: OUT_PAYMENT_RESULT },
        2: { result: LAST_PRICE_RESULT },
      }),
    )

    const state = await fetchOnChainBatchState("https://rpc.example", BATCH_ID)

    expect(state).toBeUndefined()
  })

  it("returns undefined when a sub-call returns an error", async () => {
    fetchSpy.mockResolvedValue(
      batchResponse({
        0: { result: BATCHES_RESULT },
        1: { error: { message: "execution reverted" } },
        2: { result: LAST_PRICE_RESULT },
      }),
    )

    const state = await fetchOnChainBatchState("https://rpc.example", BATCH_ID)

    expect(state).toBeUndefined()
  })

  it("returns undefined when the response is not ok", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve([]),
    } as Response)

    const state = await fetchOnChainBatchState("https://rpc.example", BATCH_ID)

    expect(state).toBeUndefined()
  })

  it("returns undefined when fetch rejects", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"))

    const state = await fetchOnChainBatchState("https://rpc.example", BATCH_ID)

    expect(state).toBeUndefined()
  })

  it("returns undefined for a malformed batch ID without calling fetch", async () => {
    const state = await fetchOnChainBatchState("https://rpc.example", "nothex")

    expect(state).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("fetchBatchTTLFromContract", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("returns the ground-truth TTL in seconds", async () => {
    fetchSpy.mockResolvedValue(batchResponse(FULL_RESPONSE))

    const ttl = await fetchBatchTTLFromContract("https://rpc.example", BATCH_ID)

    expect(ttl).toBe(EXPECTED_TTL_SECONDS)
  })

  it("returns undefined when the batch is unknown", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"))

    const ttl = await fetchBatchTTLFromContract("https://rpc.example", BATCH_ID)

    expect(ttl).toBeUndefined()
  })
})

describe("fetchAuthoritativeBatchTTL", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  const RPC = "https://rpc.example"
  const BEE = "https://bee.example"

  function beeStampResponse(batchTTL: number): Response {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ batchTTL }),
    } as Response
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("prefers the contract TTL when the contract read succeeds", async () => {
    // Answer the Bee node too, with a different value, to prove the contract wins.
    fetchSpy.mockImplementation((url) =>
      Promise.resolve(
        url === RPC ? batchResponse(FULL_RESPONSE) : beeStampResponse(999),
      ),
    )

    const ttl = await fetchAuthoritativeBatchTTL(RPC, BEE, BATCH_ID)

    expect(ttl).toBe(EXPECTED_TTL_SECONDS)
  })

  it("falls back to the Bee node batchTTL when the contract read fails", async () => {
    fetchSpy.mockImplementation((url) =>
      url === RPC
        ? Promise.reject(new Error("rpc down"))
        : Promise.resolve(beeStampResponse(86400)),
    )

    const ttl = await fetchAuthoritativeBatchTTL(RPC, BEE, BATCH_ID)

    expect(ttl).toBe(86400)
  })

  it("returns undefined when both sources fail", async () => {
    fetchSpy.mockImplementation((url) =>
      url === RPC
        ? Promise.reject(new Error("rpc down"))
        : Promise.resolve({
            ok: false,
            status: 404,
            json: () => Promise.resolve({}),
          } as Response),
    )

    const ttl = await fetchAuthoritativeBatchTTL(RPC, BEE, BATCH_ID)

    expect(ttl).toBeUndefined()
  })

  it("uses a prefetched Bee TTL instead of asking the node again", async () => {
    fetchSpy.mockImplementation((url) =>
      url === RPC
        ? Promise.reject(new Error("rpc down"))
        : Promise.resolve(beeStampResponse(111)),
    )

    const ttl = await fetchAuthoritativeBatchTTL(
      RPC,
      BEE,
      BATCH_ID,
      undefined,
      86400,
    )

    expect(ttl).toBe(86400)
    // Only the (failed) contract read went out — no /stamps round-trip.
    expect(fetchSpy.mock.calls.every(([url]) => url === RPC)).toBe(true)
  })

  it("still prefers the contract over a prefetched Bee TTL", async () => {
    fetchSpy.mockImplementation((url) =>
      Promise.resolve(
        url === RPC ? batchResponse(FULL_RESPONSE) : beeStampResponse(999),
      ),
    )

    const ttl = await fetchAuthoritativeBatchTTL(
      RPC,
      BEE,
      BATCH_ID,
      undefined,
      86400,
    )

    expect(ttl).toBe(EXPECTED_TTL_SECONDS)
  })

  it("a REJECTING prefetched promise never escapes as an unhandled rejection", async () => {
    // The doc tells callers to hand over an in-flight promise, and the contract
    // path returns without awaiting it. Without a handler attached up front
    // that rejection is unhandled — fatal in Node.
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    fetchSpy.mockImplementation(() =>
      Promise.resolve(batchResponse(FULL_RESPONSE)),
    )

    try {
      const ttl = await fetchAuthoritativeBatchTTL(
        RPC,
        BEE,
        BATCH_ID,
        undefined,
        Promise.reject(new Error("stamps read blew up")),
      )
      expect(ttl).toBe(EXPECTED_TTL_SECONDS)
      // Let the microtask queue drain so a missing handler would be reported.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("does not await a prefetched promise when the contract answers", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(batchResponse(FULL_RESPONSE)),
    )
    // A hung Bee request must not hold the whole lookup: the caller overlaps
    // it with the contract read, so a contract hit resolves without it.
    const neverResolves = new Promise<number | undefined>(() => {})

    const ttl = await fetchAuthoritativeBatchTTL(
      RPC,
      BEE,
      BATCH_ID,
      undefined,
      neverResolves,
    )

    expect(ttl).toBe(EXPECTED_TTL_SECONDS)
  })
})

describe("resolvePostageStampContractAddress", () => {
  const LOCAL = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512"

  it("honours the local override only for a local RPC", () => {
    expect(
      resolvePostageStampContractAddress("http://localhost:9545", LOCAL),
    ).toBe(LOCAL)
    expect(
      resolvePostageStampContractAddress("http://127.0.0.1:9545", LOCAL),
    ).toBe(LOCAL)
  })

  it("ignores the local override for a remote RPC (mainnet)", () => {
    expect(
      resolvePostageStampContractAddress(
        "https://xdai.fairdatasociety.org/",
        LOCAL,
      ),
    ).toBe(POSTAGE_STAMP_CONTRACT_ADDRESS)
  })

  it("falls back to mainnet when no override is given", () => {
    expect(resolvePostageStampContractAddress("http://localhost:9545")).toBe(
      POSTAGE_STAMP_CONTRACT_ADDRESS,
    )
  })
})

const ZERO_TUPLE = "0x" + "0".repeat(64 * 6)

describe("fetchOnChainBatchStateResult", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("reports found with the decoded state", async () => {
    fetchSpy.mockResolvedValue(batchResponse(FULL_RESPONSE))
    const result = await fetchOnChainBatchStateResult(
      "https://rpc.example",
      BATCH_ID,
    )
    expect(result.status).toBe("found")
    if (result.status === "found") {
      expect(result.state.lastPrice).toBe(LAST_PRICE)
    }
  })

  it("reports not-found for a zero-owner tuple", async () => {
    fetchSpy.mockResolvedValue(
      batchResponse({
        0: { result: ZERO_TUPLE },
        1: { result: OUT_PAYMENT_RESULT },
        2: { result: LAST_PRICE_RESULT },
      }),
    )
    const result = await fetchOnChainBatchStateResult(
      "https://rpc.example",
      BATCH_ID,
    )
    expect(result.status).toBe("not-found")
  })

  it("reports error when the RPC fails", async () => {
    fetchSpy.mockRejectedValue(new Error("rpc down"))
    const result = await fetchOnChainBatchStateResult(
      "https://rpc.example",
      BATCH_ID,
    )
    expect(result.status).toBe("error")
  })
})

describe("resolveBatchStatus", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  const RPC = "https://rpc.example"
  const BEE = "https://bee.example"

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("found via contract, with the contract TTL", async () => {
    fetchSpy.mockImplementation((url) =>
      Promise.resolve(
        url === RPC ? batchResponse(FULL_RESPONSE) : ({} as Response),
      ),
    )
    const result = await resolveBatchStatus(RPC, BEE, BATCH_ID)
    expect(result).toEqual({
      status: "found",
      ttlSeconds: EXPECTED_TTL_SECONDS,
    })
  })

  it("not-found is authoritative and does not consult the Bee node", async () => {
    fetchSpy.mockImplementation((url) => {
      if (url === RPC) {
        return Promise.resolve(
          batchResponse({
            0: { result: ZERO_TUPLE },
            1: { result: OUT_PAYMENT_RESULT },
            2: { result: LAST_PRICE_RESULT },
          }),
        )
      }
      throw new Error("Bee must not be consulted on contract not-found")
    })
    const result = await resolveBatchStatus(RPC, BEE, BATCH_ID)
    expect(result).toEqual({ status: "not-found" })
  })

  it("falls back to the Bee node when the contract read errors", async () => {
    fetchSpy.mockImplementation((url) =>
      url === RPC
        ? Promise.reject(new Error("rpc down"))
        : Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ batchTTL: 4242 }),
          } as Response),
    )
    const result = await resolveBatchStatus(RPC, BEE, BATCH_ID)
    expect(result).toEqual({ status: "found", ttlSeconds: 4242 })
  })

  it("is unreachable when both the contract and the Bee node fail", async () => {
    fetchSpy.mockImplementation((url) =>
      url === RPC
        ? Promise.reject(new Error("rpc down"))
        : Promise.resolve({
            ok: false,
            status: 404,
            json: () => Promise.resolve({}),
          } as Response),
    )
    const result = await resolveBatchStatus(RPC, BEE, BATCH_ID)
    expect(result).toEqual({ status: "unreachable" })
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the retry boundary sits. The rotation is the package's answer to a
 * flaky public endpoint, so what does and does not cross it is the whole
 * behaviour of this module.
 */

import { RollingValueProvider } from "cafe-utility"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { jsonRpc, jsonRpcOrUndefined } from "./fetch"
import { gnosisMainnetSettings } from "./settings"

const FIRST = "https://first.example"
const SECOND = "https://second.example"

// Rotating five times at the real backoff would put minutes on this suite.
const settings = gnosisMainnetSettings({ rpcUrls: [FIRST, SECOND] })

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response
}

function provider(): RollingValueProvider<string> {
  return new RollingValueProvider(settings.rpcUrls)
}

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch")
  // `withRetries` logs every failure through console.error.
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("jsonRpc", () => {
  // A rate-limited or gateway-erroring endpoint is the case the rotation
  // exists for, so the status check has to sit inside the retry.
  it("rotates to the next endpoint when one answers 429", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse({ error: { message: "slow down" } }, 429),
      )
      .mockResolvedValueOnce(mockResponse({ result: "0x64" }))

    await expect(
      jsonRpc(provider(), settings, "eth_chainId", []),
    ).resolves.toBe("0x64")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe(FIRST)
    expect((fetchSpy.mock.calls[1] as [string])[0]).toBe(SECOND)
  }, 20_000)

  // The other side of the boundary: every endpoint refuses a reverted call
  // identically, so rotating is the same answer five times slower.
  it("does not rotate on a JSON-RPC error", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ error: { message: "reverted" } }))

    await expect(
      jsonRpc(provider(), settings, "eth_estimateGas", []),
    ).rejects.toThrow(/refused eth_estimateGas: reverted/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("rejects an explicit null result", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ result: null }))

    await expect(
      jsonRpc(provider(), settings, "eth_getBlockByNumber", ["0x0", false]),
    ).rejects.toThrow(/returned no result/)
  })

  // The url that answered, not whichever one the provider points at by the
  // time the envelope is read.
  it("names the endpoint by origin only", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ error: { message: "nope" } }))

    await expect(
      jsonRpc(
        new RollingValueProvider([`${FIRST}/v2/secret-api-key`]),
        settings,
        "eth_chainId",
        [],
      ),
    ).rejects.toThrow(`${FIRST} refused eth_chainId: nope`)
  })
})

describe("jsonRpcOrUndefined", () => {
  it("reads an explicit null as the outcome it is", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ result: null }))

    await expect(
      jsonRpcOrUndefined(provider(), settings, "eth_getTransactionReceipt", []),
    ).resolves.toBeUndefined()
  })

  // Otherwise a malformed answer reads as "not mined yet" / "code installed".
  it("still rejects an envelope with no result member", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ jsonrpc: "2.0", id: 1 }))

    await expect(
      jsonRpcOrUndefined(provider(), settings, "anvil_setCode", []),
    ).rejects.toThrow(/malformed envelope/)
  })
})

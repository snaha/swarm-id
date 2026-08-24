// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The vendored twin of `lib/src/utils/json-rpc.test.ts`. It pins the same
 * contract, plus the null-tolerant variant this package needs and lib does not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { jsonRpcCall, jsonRpcCallOrUndefined } from "./json-rpc"

const RPC_URL = "https://rpc.example"
const OPTIONS = { timeoutMs: 1000 }

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response
}

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch")
})

afterEach(() => {
  fetchSpy.mockRestore()
})

describe("jsonRpcCall", () => {
  it("returns the result of a well-formed answer", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ jsonrpc: "2.0", id: 1, result: "0x64" }),
    )

    await expect(
      jsonRpcCall(RPC_URL, "eth_chainId", [], OPTIONS),
    ).resolves.toBe("0x64")
  })

  it("posts one JSON-RPC envelope under a deadline", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ result: "0x1" }))

    await jsonRpcCall(RPC_URL, "eth_getBalance", ["0xabc", "latest"], OPTIONS)

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(RPC_URL)
    expect(JSON.parse(init.body as string)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: ["0xabc", "latest"],
    })
    // Without this, fetch waits forever on an endpoint that never answers.
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  // The ways an endpoint can hand back something that is not an answer.
  it.each([
    ["a non-2xx status", mockResponse({ result: "0x64" }, 429)],
    [
      "a JSON-RPC error under a 200",
      mockResponse({ error: { message: "pruned" } }),
    ],
    ["no result member at all", mockResponse({ jsonrpc: "2.0", id: 1 })],
    // JSON-RPC's "no such thing": a pruned node answers an explicit null
    // rather than omitting the field.
    ["an explicit null result", mockResponse({ result: null })],
  ])("rejects %s", async (_label, response) => {
    fetchSpy.mockResolvedValue(response)

    await expect(
      jsonRpcCall(RPC_URL, "eth_getBlockByNumber", ["0x0", false], OPTIONS),
    ).rejects.toThrow()
  })

  it("names the endpoint the way the caller asked", async () => {
    fetchSpy.mockResolvedValue(mockResponse({}, 429))

    await expect(
      jsonRpcCall(RPC_URL, "eth_chainId", [], {
        ...OPTIONS,
        label: "The configured Gnosis RPC",
      }),
    ).rejects.toThrow("The configured Gnosis RPC answered 429 to eth_chainId.")
  })

  // A provider url carries its API key in the path or query, and these
  // messages reach logs and dialogs.
  it("falls back to the origin, not the whole url, when unlabelled", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ error: { message: "nope" } }))

    await expect(
      jsonRpcCall(`${RPC_URL}/v2/secret-api-key`, "eth_chainId", [], OPTIONS),
    ).rejects.toThrow(`${RPC_URL} refused eth_chainId: nope`)
  })
})

describe("jsonRpcCallOrUndefined", () => {
  it("returns a real result untouched", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ result: "0x1" }))

    await expect(
      jsonRpcCallOrUndefined(RPC_URL, "eth_getCode", ["0xabc"], OPTIONS),
    ).resolves.toBe("0x1")
  })

  // The whole point of the variant: anvil's admin methods answer null on
  // SUCCESS, and a pending transaction has no receipt yet.
  it("reads an explicit null as the outcome it is", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ jsonrpc: "2.0", result: null }))

    await expect(
      jsonRpcCallOrUndefined(RPC_URL, "anvil_setBalance", [], OPTIONS),
    ).resolves.toBeUndefined()
  })

  // The bug this variant invites: reading a malformed envelope as that same
  // outcome tells `ensureBundlingDelegate` the delegate is installed when the
  // endpoint answered nothing at all.
  it("still rejects an envelope with no result member", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ jsonrpc: "2.0", id: 1 }))

    await expect(
      jsonRpcCallOrUndefined(RPC_URL, "anvil_setCode", [], OPTIONS),
    ).rejects.toThrow(/malformed envelope/)
  })

  it.each([
    ["a non-2xx status", mockResponse({ result: null }, 503)],
    [
      "a JSON-RPC error under a 200",
      mockResponse({ error: { message: "unknown method" } }),
    ],
  ])("still rejects %s", async (_label, response) => {
    fetchSpy.mockResolvedValue(response)

    await expect(
      jsonRpcCallOrUndefined(RPC_URL, "anvil_setCode", [], OPTIONS),
    ).rejects.toThrow()
  })
})

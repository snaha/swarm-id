// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { jsonRpcBatch, jsonRpcCall } from "./json-rpc"
import { TimeoutError } from "./promise"

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

  // Both reject here, but they are not the same event, and the vendored copy
  // in `@swarm-id/multichain` lets `null` through for the methods that mean it.
  // Reading a malformed envelope as that outcome is what the split prevents.
  it("tells a malformed envelope apart from an explicit null", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ jsonrpc: "2.0", id: 1 }))
    await expect(
      jsonRpcCall(RPC_URL, "eth_chainId", [], OPTIONS),
    ).rejects.toThrow(/malformed envelope/)

    fetchSpy.mockResolvedValueOnce(mockResponse({ result: null }))
    await expect(
      jsonRpcCall(RPC_URL, "eth_chainId", [], OPTIONS),
    ).rejects.toThrow(/returned no result/)
  })

  it("names the endpoint the way the caller asked, since the message reaches users", async () => {
    fetchSpy.mockResolvedValue(mockResponse({}, 429))

    await expect(
      jsonRpcCall(RPC_URL, "eth_chainId", [], {
        ...OPTIONS,
        label: "The configured Gnosis RPC",
      }),
    ).rejects.toThrow("The configured Gnosis RPC answered 429 to eth_chainId.")
  })

  // Unlabelled it falls back to the ORIGIN, never the whole url: a provider
  // url carries its API key in the path or query, and these messages reach
  // logs and dialogs.
  it("falls back to the origin when the caller has no better name for it", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ error: { message: "nope" } }))

    await expect(
      jsonRpcCall(`${RPC_URL}/v2/secret-api-key`, "eth_chainId", [], OPTIONS),
    ).rejects.toThrow(`${RPC_URL} refused eth_chainId: nope`)
  })

  // `AbortSignal.timeout` would reject with a DOMException that merely shares
  // the name. Callers are told to discriminate a deadline with `instanceof`,
  // so it has to be the real class.
  it("rejects a blown deadline with the library's TimeoutError", async () => {
    fetchSpy.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          ;(init as RequestInit).signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          )
        }),
    )

    await expect(
      jsonRpcCall(RPC_URL, "eth_chainId", [], { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(TimeoutError)
  })
})

describe("jsonRpcBatch", () => {
  const CALLS = [
    { method: "eth_call", params: ["a"] },
    { method: "eth_call", params: ["b"] },
    { method: "eth_call", params: ["c"] },
  ]

  it("assigns ids and returns results in request order", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse([
        { id: 0, result: "0xaa" },
        { id: 1, result: "0xbb" },
        { id: 2, result: "0xcc" },
      ]),
    )

    await expect(jsonRpcBatch(RPC_URL, CALLS, OPTIONS)).resolves.toEqual([
      "0xaa",
      "0xbb",
      "0xcc",
    ])
    expect(
      JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string),
    ).toEqual([
      { jsonrpc: "2.0", id: 0, method: "eth_call", params: ["a"] },
      { jsonrpc: "2.0", id: 1, method: "eth_call", params: ["b"] },
      { jsonrpc: "2.0", id: 2, method: "eth_call", params: ["c"] },
    ])
  })

  // JSON-RPC does not promise batch ordering, so position in the response
  // array means nothing.
  it("matches by id when the endpoint answers out of order", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse([
        { id: 2, result: "0xcc" },
        { id: 0, result: "0xaa" },
        { id: 1, result: "0xbb" },
      ]),
    )

    await expect(jsonRpcBatch(RPC_URL, CALLS, OPTIONS)).resolves.toEqual([
      "0xaa",
      "0xbb",
      "0xcc",
    ])
  })

  // A partial batch is not an answer — the caller decodes these positionally
  // into one consistent snapshot.
  it.each([
    [
      "one member carries an error",
      [
        { id: 0, result: "0xaa" },
        { id: 1, error: { message: "reverted" } },
        { id: 2, result: "0xcc" },
      ],
    ],
    [
      "one member has a null result",
      [
        { id: 0, result: "0xaa" },
        { id: 1, result: null },
        { id: 2, result: "0xcc" },
      ],
    ],
    [
      "an id is out of range",
      [
        { id: 0, result: "0xaa" },
        { id: 9, result: "0xbb" },
        { id: 2, result: "0xcc" },
      ],
    ],
    [
      "an id is answered twice",
      [
        { id: 0, result: "0xaa" },
        { id: 0, result: "0xbb" },
        { id: 2, result: "0xcc" },
      ],
    ],
    ["the response is short", [{ id: 0, result: "0xaa" }]],
    ["the response is not an array", { id: 0, result: "0xaa" }],
  ])("rejects when %s", async (_label, body) => {
    fetchSpy.mockResolvedValue(mockResponse(body))

    await expect(jsonRpcBatch(RPC_URL, CALLS, OPTIONS)).rejects.toThrow()
  })

  it("rejects a non-2xx status without reading the body as answers", async () => {
    fetchSpy.mockResolvedValue(mockResponse([{ id: 0, result: "0xaa" }], 503))

    await expect(jsonRpcBatch(RPC_URL, CALLS, OPTIONS)).rejects.toThrow(/503/)
  })

  it("answers an empty batch without asking the endpoint", async () => {
    await expect(jsonRpcBatch(RPC_URL, [], OPTIONS)).resolves.toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

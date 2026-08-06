// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * LOCAL DEV / TEST ONLY — one JSON-RPC call against a URL.
 *
 * The package's own `jsonRpc` needs settings and a rotating provider, which is
 * right for production traffic and wrong for dev tooling that talks to a
 * specific endpoint (a source chain, an anvil admin method, a test assertion).
 * Four private copies of this had grown before it was worth extracting.
 */
export async function devRpc(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const data = (await response.json()) as {
    result?: unknown
    error?: { message?: string }
  }
  if (data.error) {
    throw new Error(data.error.message ?? `${url} rejected ${method}`)
  }
  return data.result
}

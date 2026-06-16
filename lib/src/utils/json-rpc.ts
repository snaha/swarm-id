// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal JSON-RPC-over-HTTP transport shared by the chain-reading utilities:
 * block-timestamp lookups in {@link ./ttl} and PostageStamp contract reads in
 * {@link ./postage-contract}.
 *
 * It handles the POST envelope and HTTP-level errors only. Callers interpret
 * the JSON-RPC `result`/`error` payload themselves, because the single-call and
 * batch response shapes differ (one object vs an array matched back by id).
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @param body - the request payload (a single call object or an array of them)
 * @returns the parsed JSON response, as `unknown` for the caller to narrow
 * @throws if the transport fails or the endpoint returns a non-OK status
 */
export async function postJsonRpc(
  rpcUrl: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`RPC request failed: HTTP ${response.status}`)
  }
  return response.json()
}

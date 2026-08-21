// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * LOCAL DEV / TEST ONLY — one JSON-RPC call against a URL, on the shared
 * `json-rpc.ts` contract.
 *
 * The package's own `jsonRpc` needs settings and a rotating provider, which is
 * right for production traffic and wrong for dev tooling that talks to a
 * specific endpoint (a source chain, an anvil admin method, a test assertion).
 * Four private copies of this had grown before it was worth extracting.
 *
 * Null-tolerant: the anvil admin methods this reaches answer `null` on success.
 */
import { jsonRpcCallOrUndefined } from "./json-rpc"

/** Generous for a chain on localhost, but still bounded. */
const DEV_RPC_TIMEOUT_MS = 10_000

export function devRpc(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  return jsonRpcCallOrUndefined(url, method, params, {
    timeoutMs: DEV_RPC_TIMEOUT_MS,
  })
}

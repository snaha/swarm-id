// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { Dates, RollingValueProvider, System } from "cafe-utility"
import type { MultichainSettings } from "./settings"

const RETRY_ATTEMPTS = 5

/**
 * Fetch against the current RPC URL with retries, rotating to the next
 * configured RPC on each failure.
 */
export async function durableFetch(
  rpcProvider: RollingValueProvider<string>,
  settings: MultichainSettings,
  method: "GET" | "POST",
  body?: unknown,
): Promise<Response> {
  return System.withRetries(
    async () =>
      fetch(rpcProvider.current(), {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(settings.fetchTimeoutMillis),
      }),
    RETRY_ATTEMPTS,
    Dates.seconds(1),
    Dates.seconds(5),
    console.error,
    () => rpcProvider.next(),
  )
}

/**
 * Single JSON-RPC call via durableFetch, returning the raw `result` field.
 * @throws when the response carries an `error` member or no `result`.
 */
export async function jsonRpc(
  rpcProvider: RollingValueProvider<string>,
  settings: MultichainSettings,
  rpcMethod: string,
  params: unknown[],
): Promise<unknown> {
  const payload = { jsonrpc: "2.0", id: 1, method: rpcMethod, params }
  const response = await durableFetch(rpcProvider, settings, "POST", payload)
  const data = (await response.json()) as {
    result?: unknown
    error?: { message?: string }
  }
  if (data.error) {
    throw new Error(`RPC error: ${data.error.message ?? "unknown"}`)
  }
  if (data.result === undefined) {
    throw new Error("JSON-RPC response missing result")
  }
  return data.result
}

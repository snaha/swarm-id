// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { Dates, RollingValueProvider, System } from "cafe-utility"
import { jsonRpcPayload, readJsonRpcResult, requireResult } from "./json-rpc"
import type { MultichainSettings } from "./settings"

const RETRY_ATTEMPTS = 5

/**
 * Fetch against the current RPC URL with retries, rotating to the next
 * configured RPC on each failure.
 */
async function durableFetch(
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
 * The `json-rpc.ts` contract over a rotating provider. The retry wraps the
 * FETCH, not the check: a transport failure is worth another endpoint, an
 * `error` answer is not.
 */
async function rotatingJsonRpc(
  rpcProvider: RollingValueProvider<string>,
  settings: MultichainSettings,
  rpcMethod: string,
  params: unknown[],
): Promise<unknown> {
  const response = await durableFetch(
    rpcProvider,
    settings,
    "POST",
    jsonRpcPayload(rpcMethod, params),
  )
  return readJsonRpcResult(response, rpcMethod, rpcProvider.current())
}

/**
 * Single JSON-RPC call via durableFetch, returning the raw `result` field.
 * @throws when the response carries an `error` member or no result.
 */
export async function jsonRpc(
  rpcProvider: RollingValueProvider<string>,
  settings: MultichainSettings,
  rpcMethod: string,
  params: unknown[],
): Promise<unknown> {
  const result = await rotatingJsonRpc(rpcProvider, settings, rpcMethod, params)
  return requireResult(result, rpcMethod, rpcProvider.current())
}

/**
 * {@link jsonRpc} for the methods whose `null` is an outcome rather than a
 * failure — `eth_getTransactionReceipt` while pending, anvil's admin methods
 * on success.
 * @returns the result, or `undefined` for JSON-RPC `null`.
 */
export function jsonRpcOrUndefined(
  rpcProvider: RollingValueProvider<string>,
  settings: MultichainSettings,
  rpcMethod: string,
  params: unknown[],
): Promise<unknown> {
  return rotatingJsonRpc(rpcProvider, settings, rpcMethod, params)
}

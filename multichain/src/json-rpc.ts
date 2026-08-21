// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The JSON-RPC-over-HTTP contract for this package. A response is an answer
 * only if it carries a 2xx status, no JSON-RPC `error` member, and a `result`.
 *
 * The result check is split off into {@link requireResult} because whether a
 * missing one is a failure is per-method: most calls need a result, but
 * `eth_getTransactionReceipt` answers `null` while a transaction is pending,
 * and anvil's admin methods (`anvil_setCode`, `anvil_setBalance`) answer `null`
 * on SUCCESS. Each call site names which it wants.
 *
 * A copy of `lib/src/utils/json-rpc.ts` rather than an import of it, because
 * this package is vendored and self-contained. Change one, change both.
 */

export interface JsonRpcOptions {
  /** Deadline for the whole request, including the response body. */
  timeoutMs: number
  /** How the endpoint is named in error messages. Defaults to the URL. */
  label?: string
}

interface JsonRpcEnvelope {
  result?: unknown
  error?: { code?: number; message?: string }
}

/** The request body for one call. Batches are not used in this package. */
export function jsonRpcPayload(
  method: string,
  params: unknown[],
): { jsonrpc: string; id: number; method: string; params: unknown[] } {
  return { jsonrpc: "2.0", id: 1, method, params }
}

/**
 * The status and `error` half of the contract, applied to a response however it
 * was fetched — `durableFetch`'s rotating retry included.
 *
 * @returns the `result`, with JSON-RPC's `null` normalised to `undefined`. Pass
 *   it through {@link requireResult} unless the method answers `null` for a
 *   real outcome.
 * @throws when the endpoint answered non-2xx or refused the call.
 */
export async function readJsonRpcResult(
  response: Response,
  method: string,
  label: string,
): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${label} answered ${response.status} to ${method}.`)
  }
  const envelope = (await response.json()) as JsonRpcEnvelope
  if (envelope.error) {
    throw new Error(
      `${label} refused ${method}: ${envelope.error.message ?? "unknown error"}`,
    )
  }
  return envelope.result ?? undefined
}

/**
 * The rest of the contract, for the methods that must produce something.
 * @throws when the result was missing or JSON-RPC `null`.
 */
export function requireResult(
  result: unknown,
  method: string,
  label: string,
): unknown {
  if (result === undefined) {
    throw new Error(`${label} returned no result for ${method}.`)
  }
  return result
}

async function post(
  url: string,
  method: string,
  params: unknown[],
  options: JsonRpcOptions,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(jsonRpcPayload(method, params)),
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  return readJsonRpcResult(response, method, options.label ?? url)
}

/**
 * One checked call against ONE url — no retries, no provider rotation. The
 * package's own `jsonRpc` is the same contract over a rotating provider.
 *
 * @throws if the transport fails, the deadline passes, the endpoint answers
 *   non-2xx or an `error`, or there is no result.
 */
export async function jsonRpcCall(
  url: string,
  method: string,
  params: unknown[],
  options: JsonRpcOptions,
): Promise<unknown> {
  const result = await post(url, method, params, options)
  return requireResult(result, method, options.label ?? url)
}

/**
 * {@link jsonRpcCall} for the methods whose `null` is an outcome rather than a
 * failure — anvil's admin calls answer `null` when they succeed.
 * @returns the result, or `undefined` for JSON-RPC `null`.
 */
export function jsonRpcCallOrUndefined(
  url: string,
  method: string,
  params: unknown[],
  options: JsonRpcOptions,
): Promise<unknown> {
  return post(url, method, params, options)
}

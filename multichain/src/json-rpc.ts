// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The JSON-RPC-over-HTTP contract for this package. A response is an answer
 * only if all three hold: a 2xx status, no JSON-RPC `error` member (which
 * arrives under a 200), and a `result` that is neither missing nor `null`.
 *
 * The last two are separate checks on purpose. A missing `result` member is a
 * malformed envelope — no method reports anything that way. An explicit `null`
 * is JSON-RPC saying "no such thing", which a handful of methods mean as a real
 * outcome: `eth_getTransactionReceipt` answers `null` while a transaction is
 * pending, and anvil's admin methods (`anvil_setCode`, `anvil_setBalance`)
 * answer `null` on SUCCESS. Collapsing the two would let a malformed envelope
 * read as that outcome — a broken endpoint reporting "delegate installed".
 * Each call site names which of the two it wants.
 *
 * A copy of `lib/src/utils/json-rpc.ts` rather than an import of it, because
 * this package is vendored and self-contained. {@link checkStatus},
 * {@link checkedResult}, {@link requireValue} and their wording are duplicated
 * verbatim from that file and must stay that way — change one, change both.
 * Only what wraps them legitimately differs: that file batches and maps its
 * deadline onto the library's `TimeoutError`, this one rotates providers.
 */

export interface JsonRpcOptions {
  /** Deadline for the whole request, including the response body. */
  timeoutMs: number
  /** How the endpoint is named in error messages. Defaults to its origin. */
  label?: string
}

export interface JsonRpcEnvelope {
  result?: unknown
  error?: { code?: number; message?: string }
}

/**
 * How the endpoint is named when the caller supplies no `label`. The origin
 * only: an RPC url's path and query are where provider API keys live, and
 * these messages reach logs and dialogs.
 */
export function defaultLabel(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).origin
  } catch {
    return "The RPC endpoint"
  }
}

/**
 * The status half of the contract.
 * @throws when the endpoint answered anything but 2xx.
 */
export function checkStatus(
  response: Response,
  subject: string,
  label: string,
): void {
  if (!response.ok) {
    throw new Error(`${label} answered ${response.status} to ${subject}.`)
  }
}

/**
 * The `error`/`result` half, for one envelope.
 *
 * @returns the result, with JSON-RPC `null` normalised to `undefined`. Pass it
 *   through {@link requireValue} unless the method means `null` as an outcome.
 * @throws when the endpoint refused the call, or answered no `result` member at
 *   all — a malformed envelope, not an outcome any method reports.
 */
export function checkedResult(
  envelope: JsonRpcEnvelope,
  subject: string,
  label: string,
): unknown {
  if (envelope.error) {
    throw new Error(
      `${label} refused ${subject}: ${envelope.error.message ?? "unknown error"}`,
    )
  }
  if (!("result" in envelope)) {
    throw new Error(`${label} returned a malformed envelope for ${subject}.`)
  }
  return envelope.result ?? undefined
}

/**
 * The rest of the contract, for the methods that must produce a value.
 * @throws when the result was JSON-RPC `null`.
 */
export function requireValue(
  result: unknown,
  subject: string,
  label: string,
): unknown {
  if (result === undefined) {
    throw new Error(`${label} returned no result for ${subject}.`)
  }
  return result
}

/** The request body for one call. Batches are not used in this package. */
export function jsonRpcPayload(
  method: string,
  params: unknown[],
): { jsonrpc: string; id: number; method: string; params: unknown[] } {
  return { jsonrpc: "2.0", id: 1, method, params }
}

async function post(
  url: string,
  method: string,
  params: unknown[],
  options: JsonRpcOptions,
): Promise<unknown> {
  const label = options.label ?? defaultLabel(url)
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(jsonRpcPayload(method, params)),
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  checkStatus(response, method, label)
  const envelope = (await response.json()) as JsonRpcEnvelope
  return checkedResult(envelope, method, label)
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
  return requireValue(result, method, options.label ?? defaultLabel(url))
}

/**
 * {@link jsonRpcCall} for the methods whose `null` is an outcome rather than a
 * failure — anvil's admin calls answer `null` when they succeed. A MALFORMED
 * envelope still rejects; only an explicit `null` becomes `undefined`.
 */
export function jsonRpcCallOrUndefined(
  url: string,
  method: string,
  params: unknown[],
  options: JsonRpcOptions,
): Promise<unknown> {
  return post(url, method, params, options)
}

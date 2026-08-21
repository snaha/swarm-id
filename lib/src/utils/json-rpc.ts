// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The JSON-RPC-over-HTTP contract for this repo. A response is an answer only
 * if all three hold: a 2xx status, no JSON-RPC `error` member (which arrives
 * under a 200), and a `result` that is neither missing nor `null`. The last
 * one matters — `null` is how JSON-RPC says "no such thing", so reading it as
 * an answer hands the caller a value that fails open rather than a rejection.
 *
 * `@swarm-id/multichain` keeps its own copy in `multichain/src/json-rpc.ts`,
 * because that package is vendored and self-contained. Change one, change both.
 */

/** A workable deadline for a chain read over a public RPC. */
export const CHAIN_READ_TIMEOUT_MS = 10_000

export interface JsonRpcOptions {
  /** Deadline for the whole request, including the response body. */
  timeoutMs: number
  /**
   * How the endpoint is named in error messages, e.g. "The configured Gnosis
   * RPC". Defaults to the URL.
   */
  label?: string
}

/** One call in a batch. Ids are assigned by {@link jsonRpcBatch}. */
export interface JsonRpcRequest {
  method: string
  params: unknown[]
}

interface JsonRpcEnvelope {
  id?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

/**
 * POST the envelope and return the parsed body, HTTP status checked. The
 * single-call and batch response shapes diverge from here.
 */
async function postJsonRpc(
  rpcUrl: string,
  body: unknown,
  subject: string,
  options: JsonRpcOptions,
): Promise<unknown> {
  const label = options.label ?? rpcUrl
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`${label} answered ${response.status} to ${subject}.`)
  }
  return response.json()
}

/**
 * The `error`/`result` half of the contract, for one envelope — a single call
 * or one member of a batch.
 * @throws when the endpoint refused the call or returned no usable result.
 */
function checkedResult(
  envelope: JsonRpcEnvelope,
  subject: string,
  label: string,
): unknown {
  if (envelope.error) {
    throw new Error(
      `${label} refused ${subject}: ${envelope.error.message ?? "unknown error"}`,
    )
  }
  if (envelope.result === undefined || envelope.result === null) {
    throw new Error(`${label} returned no result for ${subject}.`)
  }
  return envelope.result
}

/**
 * One checked JSON-RPC call. `T` is a cast, not a validation — a caller that
 * reads a field off the result should check that field's type itself.
 *
 * @throws if the transport fails, the deadline passes, the endpoint answers
 *   non-2xx, or the response carries an `error` or no usable `result`.
 */
export async function jsonRpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  options: JsonRpcOptions,
): Promise<T> {
  const envelope = (await postJsonRpc(
    rpcUrl,
    { jsonrpc: "2.0", id: 1, method, params },
    method,
    options,
  )) as JsonRpcEnvelope
  return checkedResult(envelope, method, options.label ?? rpcUrl) as T
}

/**
 * A batch of checked calls, returned in the same order as `requests`. Responses
 * are matched back by id, since JSON-RPC does not promise batch ordering.
 *
 * @throws if the transport fails, the batch comes back the wrong shape or with
 *   ids that do not match the requests, or ANY member fails the contract —
 *   a partial batch is not an answer.
 */
export async function jsonRpcBatch(
  rpcUrl: string,
  requests: JsonRpcRequest[],
  options: JsonRpcOptions,
): Promise<unknown[]> {
  if (requests.length === 0) {
    return []
  }
  const label = options.label ?? rpcUrl
  const subject = `a batch of ${requests.length} calls`
  const payload = requests.map((request, id) => ({
    jsonrpc: "2.0",
    id,
    method: request.method,
    params: request.params,
  }))

  const data = await postJsonRpc(rpcUrl, payload, subject, options)
  if (!Array.isArray(data) || data.length !== requests.length) {
    throw new Error(`${label} returned a malformed response to ${subject}.`)
  }

  const results: unknown[] = new Array(requests.length)
  const seen = new Set<number>()
  for (const envelope of data as JsonRpcEnvelope[]) {
    const { id } = envelope
    if (typeof id !== "number" || id < 0 || id >= requests.length) {
      throw new Error(`${label} returned a response with an unknown id.`)
    }
    if (seen.has(id)) {
      throw new Error(`${label} returned two responses for id ${id}.`)
    }
    seen.add(id)
    results[id] = checkedResult(envelope, requests[id].method, label)
  }
  // Unique, in-range ids over exactly `requests.length` responses: every slot
  // was written, so the array holds no holes.
  return results
}

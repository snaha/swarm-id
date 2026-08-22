// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The JSON-RPC-over-HTTP contract for this repo. A response is an answer only
 * if all three hold: a 2xx status, no JSON-RPC `error` member (which arrives
 * under a 200), and a `result` that is neither missing nor `null`.
 *
 * The last two are separate checks on purpose. A missing `result` member is a
 * malformed envelope — no method reports anything that way. An explicit `null`
 * is JSON-RPC saying "no such thing", which a handful of methods mean as a real
 * outcome (`eth_getTransactionReceipt` while pending, anvil's admin calls on
 * success). Collapsing the two lets a malformed envelope read as that outcome.
 *
 * `@swarm-id/multichain` keeps its own copy in `multichain/src/json-rpc.ts`,
 * because that package is vendored and self-contained. {@link checkStatus},
 * {@link checkedResult}, {@link requireValue} and their wording are duplicated
 * verbatim there and must stay that way — change one, change both. Only what
 * wraps them legitimately differs: this file batches, that one rotates
 * providers, and only this one maps the deadline onto {@link TimeoutError},
 * which is the published library's discriminator.
 */

import { TimeoutError } from "./promise"

/** A workable deadline for a chain read over a public RPC. */
export const CHAIN_READ_TIMEOUT_MS = 10_000

export interface JsonRpcOptions {
  /** Deadline for the whole request, including the response body. */
  timeoutMs: number
  /**
   * How the endpoint is named in error messages, e.g. "The configured Gnosis
   * RPC". Defaults to the endpoint's origin.
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
 * How the endpoint is named when the caller supplies no `label`. The origin
 * only: an RPC url's path and query are where provider API keys live, and
 * these messages reach logs and dialogs.
 */
function defaultLabel(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).origin
  } catch {
    return "The RPC endpoint"
  }
}

/** Every member is optional, so being an object is the whole check. */
function isEnvelope(value: unknown): value is JsonRpcEnvelope {
  return typeof value === "object" && value !== null
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The status half of the contract.
 * @throws when the endpoint answered anything but 2xx.
 */
function checkStatus(response: Response, subject: string, label: string): void {
  if (!response.ok) {
    throw new Error(`${label} answered ${response.status} to ${subject}.`)
  }
}

/**
 * The `error`/`result` half, for one envelope — a single call or one member of
 * a batch.
 *
 * @returns the result, with JSON-RPC `null` normalised to `undefined`. Pass it
 *   through {@link requireValue} unless the method means `null` as an outcome.
 * @throws when the endpoint refused the call, or answered no `result` member at
 *   all — a malformed envelope, not an outcome any method reports.
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
  if (!("result" in envelope)) {
    throw new Error(`${label} returned a malformed envelope for ${subject}.`)
  }
  return envelope.result ?? undefined
}

/**
 * The rest of the contract, for the methods that must produce a value.
 * @throws when the result was JSON-RPC `null`.
 */
function requireValue(
  result: unknown,
  subject: string,
  label: string,
): unknown {
  if (result === undefined) {
    throw new Error(`${label} returned no result for ${subject}.`)
  }
  return result
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
  const label = options.label ?? defaultLabel(rpcUrl)
  // The abort is owned here rather than taken from `AbortSignal.timeout`, so a
  // deadline surfaces as this repo's `TimeoutError` — the one thing callers are
  // told to discriminate on — instead of a DOMException that merely shares its
  // name, and so the timer is cleared once the read settles either way.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  /** The deadline outranks whatever shape the abort surfaced as downstream. */
  const deadlineOr = (message: string): Error =>
    controller.signal.aborted
      ? new TimeoutError(
          `${label} did not answer ${subject} within ${options.timeoutMs}ms.`,
        )
      : new Error(message)
  try {
    // `checkStatus` names the endpoint; `fetch` and `json()` do not. They
    // reject with "Failed to fetch" and "Unexpected token <" — wording that
    // reaches a drive dialog naming neither the endpoint nor the call, and
    // unreachable and unparseable are the likeliest failures of the three.
    let response: Response
    try {
      response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      throw deadlineOr(
        `${label} could not be reached for ${subject}: ${messageOf(error)}`,
      )
    }
    checkStatus(response, subject, label)
    try {
      return (await response.json()) as unknown
    } catch {
      throw deadlineOr(
        `${label} answered ${subject} with a body that is not JSON.`,
      )
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One checked JSON-RPC call. `T` is a cast, not a validation — a caller that
 * reads a field off the result should check that field's type itself.
 *
 * @throws if the transport fails, the endpoint answers non-2xx, or the response
 *   carries an `error` or no usable `result`; a {@link TimeoutError} once the
 *   deadline passes.
 */
export async function jsonRpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  options: JsonRpcOptions,
): Promise<T> {
  const label = options.label ?? defaultLabel(rpcUrl)
  const envelope = (await postJsonRpc(
    rpcUrl,
    { jsonrpc: "2.0", id: 1, method, params },
    method,
    options,
  )) as JsonRpcEnvelope
  return requireValue(
    checkedResult(envelope, method, label),
    method,
    label,
  ) as T
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
  const label = options.label ?? defaultLabel(rpcUrl)
  const subject = `a batch of ${requests.length} calls`
  const payload = requests.map((request, id) => ({
    jsonrpc: "2.0",
    id,
    method: request.method,
    params: request.params,
  }))

  const malformed = () =>
    new Error(`${label} returned a malformed response to ${subject}.`)

  const data = await postJsonRpc(rpcUrl, payload, subject, options)
  if (!Array.isArray(data)) {
    // A provider that refuses the batch outright — over its size limit, say —
    // answers one envelope rather than an array, and the reason it gives is
    // the one worth reporting.
    if (isEnvelope(data) && data.error) {
      checkedResult(data, subject, label)
    }
    throw malformed()
  }
  if (data.length !== requests.length) {
    throw malformed()
  }

  const results: unknown[] = new Array(requests.length)
  const seen = new Set<number>()
  for (const envelope of data) {
    if (!isEnvelope(envelope)) {
      throw malformed()
    }
    const { id } = envelope
    if (typeof id !== "number" || id < 0 || id >= requests.length) {
      throw new Error(`${label} returned a response with an unknown id.`)
    }
    if (seen.has(id)) {
      throw new Error(`${label} returned two responses for id ${id}.`)
    }
    seen.add(id)
    const method = requests[id].method
    results[id] = requireValue(
      checkedResult(envelope, method, label),
      method,
      label,
    )
  }
  // Unique, in-range ids over exactly `requests.length` responses: every slot
  // was written, so the array holds no holes.
  return results
}

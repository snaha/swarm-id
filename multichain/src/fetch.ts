// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { Dates, RollingValueProvider, System } from "cafe-utility"
import {
  checkStatus,
  checkedResult,
  defaultLabel,
  type JsonRpcEnvelope,
  jsonRpcPayload,
  requireValue,
} from "./json-rpc"
import type { MultichainSettings } from "./settings"

const RETRY_ATTEMPTS = 5

/**
 * POST against the current RPC URL with retries, rotating to the next
 * configured RPC on each failure.
 *
 * The STATUS check runs INSIDE the retry, alongside the transport failure it
 * belongs with: a 429 from a rate-limited public endpoint, or a 502 from one
 * behind a broken gateway, is that endpoint being unavailable — precisely what
 * the rotation exists for. The JSON-RPC `error` check deliberately stays
 * outside, in {@link rotatingJsonRpc}: every endpoint refuses a reverted
 * `eth_estimateGas` identically, so retrying it is the same answer five times
 * slower.
 */
async function durableFetch(
  rpcProvider: RollingValueProvider<string>,
  settings: MultichainSettings,
  subject: string,
  body: unknown,
): Promise<{ response: Response; label: string }> {
  return System.withRetries(
    async () => {
      // Read the url INSIDE the attempt: the provider rotates between attempts,
      // so one captured outside would name an endpoint that never answered.
      const url = rpcProvider.current()
      const label = defaultLabel(url)
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(settings.fetchTimeoutMillis),
      })
      checkStatus(response, subject, label)
      return { response, label }
    },
    RETRY_ATTEMPTS,
    Dates.seconds(1),
    Dates.seconds(5),
    console.error,
    () => rpcProvider.next(),
  )
}

/** The `json-rpc.ts` contract over a rotating provider. */
async function rotatingJsonRpc(
  rpcProvider: RollingValueProvider<string>,
  settings: MultichainSettings,
  rpcMethod: string,
  params: unknown[],
): Promise<{ result: unknown; label: string }> {
  const { response, label } = await durableFetch(
    rpcProvider,
    settings,
    rpcMethod,
    jsonRpcPayload(rpcMethod, params),
  )
  const envelope = (await response.json()) as JsonRpcEnvelope
  return { result: checkedResult(envelope, rpcMethod, label), label }
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
  const { result, label } = await rotatingJsonRpc(
    rpcProvider,
    settings,
    rpcMethod,
    params,
  )
  return requireValue(result, rpcMethod, label)
}

/**
 * {@link jsonRpc} for the methods whose `null` is an outcome rather than a
 * failure — `eth_getTransactionReceipt` while pending, anvil's admin methods
 * on success.
 * @returns the result, or `undefined` for JSON-RPC `null`.
 */
export async function jsonRpcOrUndefined(
  rpcProvider: RollingValueProvider<string>,
  settings: MultichainSettings,
  rpcMethod: string,
  params: unknown[],
): Promise<unknown> {
  const { result } = await rotatingJsonRpc(
    rpcProvider,
    settings,
    rpcMethod,
    params,
  )
  return result
}

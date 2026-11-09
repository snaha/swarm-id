// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one place a caught failure becomes what the bridge carries (#761). The
 * proxy's own refusals are thrown as `SwarmIdError` and pass through; every
 * other class the proxy can meet is named here, and the rest is `internal`
 * with its message kept.
 */

import { BeeResponseError } from "@ethersphere/bee-js"
import { ZodError } from "zod"
import { SwarmIdError } from "../errors"
import type { WireError } from "../types"

// The lib's own classes are told apart by `name`, which each sets, rather
// than imported for `instanceof`: importing the coordinator and the
// utilization module from here closed a cycle back through
// `partition-state`, whose schema literal then read `NUM_BUCKETS` as
// undefined. This module must stay a leaf.
const LIB_ERROR_CODES: Record<string, WireError["code"]> = {
  PartitionContendedError: "partition-contended",
  PartitionLeaseLostError: "lease-lost",
  TimeoutError: "timeout",
}

/** Bee's error body is `{ code, message }`; the gateway may answer plain text */
function beeMessageOf(body: unknown): string | undefined {
  if (typeof body === "string") return body || undefined
  if (body && typeof body === "object" && "message" in body) {
    const { message } = body as { message: unknown }
    if (typeof message === "string") return message
  }
  return undefined
}

/**
 * The endpoint that refused, without its host: bee-js joins the node's base
 * URL in, and the user's node — a LAN address, an internal hostname — is
 * theirs, not the dApp's to learn from an error.
 */
export function refusedPath(url: string): string | undefined {
  try {
    return new URL(url).pathname
  } catch {
    return undefined
  }
}

export function toWireError(error: unknown, fallback: string): WireError {
  if (error instanceof SwarmIdError) return error.toWire()
  if (!(error instanceof Error)) return { error: fallback, code: "internal" }
  const wire: WireError = { error: error.message, code: "internal" }
  if (error instanceof BeeResponseError) {
    wire.code = "bee-rejected"
    if (error.status !== undefined) wire.status = error.status
    const beeMessage = beeMessageOf(error.responseBody)
    if (beeMessage !== undefined) wire.beeMessage = beeMessage
    const path = refusedPath(error.url)
    if (path !== undefined) wire.url = path
  } else if (error.name === "SocUploadError") {
    const { status, body } = error as Error & { status: number; body: string }
    wire.code = "bee-rejected"
    wire.status = status
    wire.beeMessage = body
  } else if (error.name in LIB_ERROR_CODES) {
    wire.code = LIB_ERROR_CODES[error.name]
  } else if (error instanceof ZodError) {
    wire.code = "invalid-request"
  } else if (error instanceof TypeError && /fetch/i.test(error.message)) {
    // `fetch` rejects with a TypeError and no response when the request
    // never completed: DNS, a refused connection, or a CORS preflight the
    // gateway rejected (#752).
    wire.code = "network"
  }
  return wire
}

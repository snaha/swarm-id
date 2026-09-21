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
import { PartitionContendedError } from "../sync/batch-write-coordinator"
import { PartitionLeaseLostError } from "../utils/batch-utilization"
import { TimeoutError } from "../utils/promise"
import { SocUploadError } from "./upload"

/** Bee's error body is `{ code, message }`; the gateway may answer plain text */
function beeMessageOf(body: unknown): string | undefined {
  if (typeof body === "string") return body || undefined
  if (body && typeof body === "object" && "message" in body) {
    const { message } = body as { message: unknown }
    if (typeof message === "string") return message
  }
  return undefined
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
    wire.url = error.url
  } else if (error instanceof SocUploadError) {
    wire.code = "bee-rejected"
    wire.status = error.status
    wire.beeMessage = error.body
  } else if (error instanceof PartitionContendedError) {
    wire.code = "partition-contended"
  } else if (error instanceof PartitionLeaseLostError) {
    wire.code = "lease-lost"
  } else if (error instanceof TimeoutError) {
    wire.code = "timeout"
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

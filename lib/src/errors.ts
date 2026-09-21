// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SwarmIdErrorCode,
  UploadUnavailableReason,
  WireError,
} from "./types"

/** The optional fields of a `SwarmIdError`, by code */
export interface SwarmIdErrorDetails {
  /** With `upload-unavailable`: why the session refuses to stamp */
  reason?: UploadUnavailableReason
  /** With `bee-rejected`: the HTTP status Bee or the gateway answered */
  status?: number
  /** With `bee-rejected`: Bee's own message from the response body */
  beeMessage?: string
  /** With `bee-rejected`: the path of the request that was refused (no host) */
  url?: string
  cause?: unknown
}

/**
 * Every rejection a `SwarmIdClient` call produces (#761). `message` is the
 * text a caller always got; `code` is the stable part to branch on, and the
 * details are set for the codes that have them.
 *
 * Constructed on the client side from the wire fields: an `Error` posted
 * through the iframe bridge arrives as a plain `Error` (structured clone keeps
 * `name` and `message` only), so the instance never crosses it. Prefer
 * `error.code` over `instanceof` in a dApp that may bundle two copies of the
 * package.
 */
export class SwarmIdError extends Error {
  readonly code: SwarmIdErrorCode
  readonly reason?: UploadUnavailableReason
  readonly status?: number
  readonly beeMessage?: string
  readonly url?: string

  constructor(
    code: SwarmIdErrorCode,
    message: string,
    details: SwarmIdErrorDetails = {},
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    )
    this.name = "SwarmIdError"
    this.code = code
    if (details.reason !== undefined) this.reason = details.reason
    if (details.status !== undefined) this.status = details.status
    if (details.beeMessage !== undefined) this.beeMessage = details.beeMessage
    if (details.url !== undefined) this.url = details.url
  }

  /** The fields that cross the bridge */
  toWire(): WireError {
    return {
      error: this.message,
      code: this.code,
      ...(this.reason !== undefined && { reason: this.reason }),
      ...(this.status !== undefined && { status: this.status }),
      ...(this.beeMessage !== undefined && { beeMessage: this.beeMessage }),
      ...(this.url !== undefined && { url: this.url }),
    }
  }

  static fromWire(wire: WireError): SwarmIdError {
    const { error, code, ...details } = wire
    return new SwarmIdError(code, error, details)
  }
}

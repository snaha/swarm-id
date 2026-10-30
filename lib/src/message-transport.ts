// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The request/response half of the client's conversation with its proxy
 * iframe: request ids, the requests still waiting for an answer, their
 * deadlines, and the progress callbacks of in-flight uploads.
 *
 * It does not listen. The client's window listener checks each message's
 * source and origin, parses it, and hands the answers it finds here.
 */

import { SwarmIdError } from "./errors"
import {
  ParentToIframeMessageSchema,
  type ParentToIframeMessage,
  type RequestOptions,
  type UploadProgress,
} from "./types"

/** The largest delay `setTimeout` honours; past it, it fires almost at once. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

interface PendingRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
}

export interface MessageTransportOptions {
  /** The proxy iframe's window, or undefined while there is none. */
  target: () => Window | undefined
  /** The origin every message is posted to. */
  targetOrigin: string
  /** Round-trip bound for a request that does not set its own. */
  timeout: number
}

export class MessageTransport {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly progressListeners = new Map<
    string,
    (progress: UploadProgress) => void
  >()
  private requestIdCounter = 0

  constructor(private readonly options: MessageTransportOptions) {}

  /** How many requests are still waiting for an answer. */
  get pendingCount(): number {
    return this.pending.size
  }

  nextRequestId(): string {
    return `req-${++this.requestIdCounter}-${Date.now()}`
  }

  /** Validate a message and post it to the iframe, expecting no answer. */
  post(message: ParentToIframeMessage): void {
    const target = this.options.target()
    if (!target) {
      throw new SwarmIdError("invalid-state", "Iframe not initialized")
    }

    try {
      ParentToIframeMessageSchema.parse(message)
    } catch (error) {
      throw new SwarmIdError(
        "invalid-request",
        `Invalid message format: ${error}`,
        { cause: error },
      )
    }

    target.postMessage(message, this.options.targetOrigin)
  }

  /** Post a request and wait for the answer carrying its id. */
  request<
    TResponse,
    TRequest extends ParentToIframeMessage & { requestId: string } =
      ParentToIframeMessage & {
        requestId: string
      },
  >(message: TRequest): Promise<TResponse> {
    // A per-call `requestOptions.timeout` bounds this whole round trip, not
    // only the Bee request the proxy makes with it: a caller raising it for a
    // large upload must not be cut off at the constructor default (#775).
    const timeout = this.roundTripTimeout(
      (message as { requestOptions?: RequestOptions }).requestOptions?.timeout,
    )
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(message.requestId)
        reject(
          new SwarmIdError("timeout", `Request timeout after ${timeout}ms`),
        )
      }, timeout)

      this.pending.set(message.requestId, {
        resolve,
        reject,
        timeoutId,
      })

      this.post(message)
    })
  }

  /** Settle the request `requestId` with its answer, if it is still waiting. */
  resolve(requestId: string, response: unknown): void {
    this.take(requestId)?.resolve(response)
  }

  /** Fail the request `requestId`, if it is still waiting. */
  reject(requestId: string, error: Error): void {
    this.take(requestId)?.reject(error)
  }

  /**
   * Forward progress for one request to a callback. Returns the function that
   * stops forwarding; a no-op without a callback.
   */
  listenForProgress(
    requestId: string,
    onProgress: ((progress: UploadProgress) => void) | undefined,
  ): () => void {
    if (!onProgress) return () => {}
    this.progressListeners.set(requestId, onProgress)
    return () => {
      this.progressListeners.delete(requestId)
    }
  }

  /** Report progress to the request's callback. Settles nothing. */
  progress(requestId: string, progress: UploadProgress): void {
    this.progressListeners.get(requestId)?.(progress)
  }

  /** Fail every waiting request with `error()` and forget all callbacks. */
  close(error: () => Error): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timeoutId)
      pending.reject(error())
    })
    this.pending.clear()
    this.progressListeners.clear()
  }

  private take(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId)
    if (pending) {
      clearTimeout(pending.timeoutId)
      this.pending.delete(requestId)
    }
    return pending
  }

  /**
   * The round-trip bound for one call, from its own `requestOptions.timeout`.
   *
   * Only a value `setTimeout` can honour is taken. Zero and negatives mean
   * "no timeout" to Bee, which is where this option went before it also bound
   * the round trip — taken literally here they would reject on the next tick,
   * the opposite of what the caller asked, so they fall back to the client
   * default and still reach Bee unchanged. A value past the 32-bit timer
   * ceiling means "as long as it takes", and `setTimeout` would wrap it into
   * firing almost at once, so it clamps to the ceiling instead. `Infinity` and
   * `NaN` never get this far: `z.number()` rejects them on the way out.
   */
  private roundTripTimeout(perCall: number | undefined): number {
    if (perCall === undefined || perCall <= 0) {
      return this.options.timeout
    }
    return Math.min(perCall, MAX_TIMER_DELAY_MS)
  }
}

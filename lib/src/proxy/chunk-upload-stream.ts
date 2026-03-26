// Copyright 2024 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser-compatible WebSocket chunk upload stream for Bee's /chunks/stream endpoint.
 *
 * Uses per-chunk stamping: each message is stamp[113 bytes] + chunkData.
 * The caller is responsible for prepending the marshaled stamp before calling uploadChunk().
 *
 * Concurrency is controlled via a semaphore pattern: up to `concurrency` chunks
 * can be in-flight (sent but not yet acknowledged). WebSocket message ordering
 * guarantees FIFO ack matching.
 */

const WS_CHUNK_STREAM_PATH = "/chunks/stream"
const WS_DEFAULT_CONCURRENCY = 32
const WS_ACK_TIMEOUT_MS = 900_000 // 15 minutes, matching Bee's streamReadTimeout

interface PendingAck {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ChunkUploadStreamOptions {
  tag?: number
  concurrency?: number
}

export class ChunkUploadStream {
  private ws: WebSocket | undefined
  private pendingAcks: PendingAck[] = []
  private concurrency: number
  private closed = false
  private errorMessage: string | undefined

  constructor(
    private beeUrl: string,
    private options?: ChunkUploadStreamOptions,
  ) {
    this.concurrency = options?.concurrency ?? WS_DEFAULT_CONCURRENCY
  }

  getConcurrency(): number {
    return this.concurrency
  }

  /**
   * Open the WebSocket connection to Bee's chunk stream endpoint.
   * Resolves when the connection is established.
   */
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.buildWsUrl()
      this.ws = new WebSocket(wsUrl)
      this.ws.binaryType = "arraybuffer"

      this.ws.onopen = () => {
        resolve()
      }

      this.ws.onerror = () => {
        const msg = "WebSocket connection error"
        this.errorMessage = msg
        this.rejectAllPending(new Error(msg))
        reject(new Error(msg))
      }

      this.ws.onmessage = () => {
        // Each ack from Bee is an empty binary message
        const pending = this.pendingAcks.shift()
        if (pending) {
          clearTimeout(pending.timer)
          pending.resolve()
        }
      }

      this.ws.onclose = (event) => {
        if (!this.closed) {
          const msg = `WebSocket closed unexpectedly: ${event.code} ${event.reason}`
          this.errorMessage = msg
          this.rejectAllPending(new Error(msg))
        }
      }
    })
  }

  /**
   * Send a stamped chunk over the WebSocket.
   * The data should already have the 113-byte stamp prepended.
   *
   * Respects concurrency limits — will wait if too many chunks are in-flight.
   */
  async uploadChunk(stampedData: Uint8Array): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(this.errorMessage ?? "WebSocket is not open")
    }

    // Wait for a concurrency slot if at capacity
    while (this.pendingAcks.length >= this.concurrency) {
      await this.waitForAck()
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("WebSocket chunk ack timeout"))
      }, WS_ACK_TIMEOUT_MS)

      this.pendingAcks.push({ resolve, reject, timer })
      try {
        this.ws!.send(stampedData)
      } catch (err) {
        // send() failed (e.g. buffer full) — remove pending ack and reject
        this.pendingAcks.pop()
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error("WebSocket send failed"))
      }
    })
  }

  /**
   * Wait for all pending acks to resolve, then close the WebSocket.
   */
  async close(): Promise<void> {
    // Wait for all in-flight chunks to be acknowledged
    while (this.pendingAcks.length > 0) {
      await this.waitForAck()
    }

    this.closed = true
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close()
    }
  }

  private buildWsUrl(): string {
    // Convert http(s) to ws(s)
    let base = this.beeUrl
    if (base.startsWith("https://")) {
      base = "wss://" + base.slice("https://".length)
    } else if (base.startsWith("http://")) {
      base = "ws://" + base.slice("http://".length)
    }

    // Remove trailing slash
    if (base.endsWith("/")) {
      base = base.slice(0, -1)
    }

    let url = base + WS_CHUNK_STREAM_PATH

    // Add tag as query parameter if provided
    if (this.options?.tag) {
      url += `?swarm-tag=${this.options.tag}`
    }

    return url
  }

  /**
   * Wait for the next ack to arrive (used for concurrency back-pressure).
   */
  private waitForAck(): Promise<void> {
    const oldest = this.pendingAcks[0]
    if (!oldest) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const originalResolve = oldest.resolve
      oldest.resolve = () => {
        originalResolve()
        resolve()
      }
      const originalReject = oldest.reject
      oldest.reject = (error: Error) => {
        originalReject(error)
        reject(error)
      }
    })
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingAcks) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingAcks = []
  }
}

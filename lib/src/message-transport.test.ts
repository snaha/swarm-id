// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The client's request bookkeeping without a client, an iframe or a window
 * listener: what a request waits for, when it gives up, and what it leaves
 * behind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MessageTransport } from "./message-transport"
import type { ParentToIframeMessage } from "./types"

const TARGET_ORIGIN = "https://swarm-id.example.com"
const TIMEOUT_MS = 5000
const PER_CALL_TIMEOUT_MS = 12_000
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1
const REFERENCE = "ab".repeat(32)

describe("MessageTransport", () => {
  let postMessage: ReturnType<typeof vi.fn>
  let target: Window | undefined
  let transport: MessageTransport

  const lastPosted = (): ParentToIframeMessage =>
    postMessage.mock.calls[postMessage.mock.calls.length - 1][0]

  const getPostageBatch = () =>
    transport.request({
      type: "getPostageBatch",
      requestId: transport.nextRequestId(),
    })

  const listFiles = (timeout: number) =>
    transport.request({
      type: "listFiles",
      requestId: transport.nextRequestId(),
      reference: REFERENCE,
      requestOptions: { timeout },
    })

  beforeEach(() => {
    vi.useFakeTimers()
    postMessage = vi.fn()
    target = { postMessage } as unknown as Window
    transport = new MessageTransport({
      target: () => target,
      targetOrigin: TARGET_ORIGIN,
      timeout: TIMEOUT_MS,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("post", () => {
    it("posts a valid message to the target origin", () => {
      const message = { type: "getNodeInfo", requestId: "r" } as const
      transport.post(message)
      expect(postMessage).toHaveBeenCalledWith(message, TARGET_ORIGIN)
    })

    it("refuses with invalid-state while there is no iframe", () => {
      target = undefined
      expect(() =>
        transport.post({ type: "getNodeInfo", requestId: "r" }),
      ).toThrow(expect.objectContaining({ code: "invalid-state" }))
    })

    it("refuses a message the schema rejects with invalid-request", () => {
      expect(() =>
        transport.post({
          type: "listFiles",
          requestId: "r",
          reference: "not a reference",
        } as ParentToIframeMessage),
      ).toThrow(expect.objectContaining({ code: "invalid-request" }))
      expect(postMessage).not.toHaveBeenCalled()
    })
  })

  it("hands out a new id per request", () => {
    expect(transport.nextRequestId()).not.toBe(transport.nextRequestId())
  })

  it("resolves a request with the answer carrying its id", async () => {
    const request = getPostageBatch()
    const { requestId } = lastPosted() as { requestId: string }
    const answer = { type: "getPostageBatchResponse", requestId }

    transport.resolve(requestId, answer)

    await expect(request).resolves.toBe(answer)
    expect(transport.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("leaves a request waiting when an answer carries another id", () => {
    getPostageBatch()
    transport.resolve("someone-else", {})
    expect(transport.pendingCount).toBe(1)
  })

  it("rejects a request with the error it is given", async () => {
    const request = getPostageBatch()
    const { requestId } = lastPosted() as { requestId: string }
    const error = new Error("proxy said no")

    transport.reject(requestId, error)

    await expect(request).rejects.toBe(error)
    expect(transport.pendingCount).toBe(0)
  })

  describe("deadline", () => {
    it("times out at the default, and forgets the request", async () => {
      const rejected = expect(getPostageBatch()).rejects.toMatchObject({
        code: "timeout",
        message: `Request timeout after ${TIMEOUT_MS}ms`,
      })

      await vi.advanceTimersByTimeAsync(TIMEOUT_MS)

      await rejected
      expect(transport.pendingCount).toBe(0)
    })

    it("ignores an answer that arrives after it", async () => {
      const rejected = expect(getPostageBatch()).rejects.toMatchObject({
        code: "timeout",
      })
      const { requestId } = lastPosted() as { requestId: string }
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
      await rejected

      transport.resolve(requestId, {})

      expect(transport.pendingCount).toBe(0)
    })

    it("takes a per-call requestOptions.timeout", async () => {
      const rejected = expect(listFiles(PER_CALL_TIMEOUT_MS)).rejects.toThrow(
        `Request timeout after ${PER_CALL_TIMEOUT_MS}ms`,
      )

      await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
      expect(transport.pendingCount).toBe(1)

      await vi.advanceTimersByTimeAsync(PER_CALL_TIMEOUT_MS - TIMEOUT_MS)
      await rejected
    })

    it.each([
      ["zero", 0],
      ["a negative", -1],
    ])("falls back to the default for %s per-call timeout", async (_, ms) => {
      const rejected = expect(listFiles(ms)).rejects.toThrow(
        `Request timeout after ${TIMEOUT_MS}ms`,
      )
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
      await rejected
    })

    it("clamps a per-call timeout past the timer ceiling", async () => {
      const rejected = expect(
        listFiles(MAX_TIMER_DELAY_MS + 1),
      ).rejects.toThrow(`Request timeout after ${MAX_TIMER_DELAY_MS}ms`)

      await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
      expect(transport.pendingCount).toBe(1)

      await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS)
      await rejected
    })
  })

  describe("progress", () => {
    it("forwards progress until stopped, settling nothing", () => {
      getPostageBatch()
      const { requestId } = lastPosted() as { requestId: string }
      const seen: number[] = []
      const stop = transport.listenForProgress(requestId, (p) =>
        seen.push(p.processed),
      )

      transport.progress(requestId, { total: 2, processed: 1 })
      stop()
      transport.progress(requestId, { total: 2, processed: 2 })

      expect(seen).toEqual([1])
      expect(transport.pendingCount).toBe(1)
    })

    it("registers nothing without a callback", () => {
      expect(() => transport.listenForProgress("r", undefined)()).not.toThrow()
    })
  })

  it("close rejects every waiting request and clears its timer", async () => {
    const first = getPostageBatch()
    const second = getPostageBatch()
    const closed = () => new Error("closed")

    transport.close(closed)

    await expect(first).rejects.toThrow("closed")
    await expect(second).rejects.toThrow("closed")
    expect(transport.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

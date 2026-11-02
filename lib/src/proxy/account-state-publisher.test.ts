// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The account-state publish scheduler without a proxy: debouncing, how
 * reasons coalesce, one publish in flight, and the roster-append retry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { rosterRetryDelayMs } from "../sync/device-roster"
import {
  AccountStatePublisher,
  PUBLISH_DEBOUNCE_MS,
  type FeedPublishOutcome,
  type PublishReason,
} from "./account-state-publisher"

const PARTIAL: FeedPublishOutcome = {
  status: "partial",
  warning: "roster membership unconfirmed",
}

describe("AccountStatePublisher", () => {
  let deltas: number
  let feedCalls: PublishReason[]
  let outcomes: FeedPublishOutcome[]
  let publisher: AccountStatePublisher

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    deltas = 0
    feedCalls = []
    outcomes = []
    publisher = new AccountStatePublisher({
      publishDelta: () => {
        deltas++
      },
      publishToFeed: async (reason) => {
        feedCalls.push(reason)
        return outcomes.shift() ?? { status: "published" }
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("publishes once per debounce window", async () => {
    publisher.schedule("acquired")
    publisher.schedule("acquired")
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS - 1)
    expect(feedCalls).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(feedCalls).toEqual(["acquired"])
    expect(deltas).toBe(0)
  })

  it("lets a change win over an acquire in the same window", async () => {
    publisher.schedule("change")
    publisher.schedule("acquired")
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS)

    expect(feedCalls).toEqual(["change"])
    expect(deltas).toBe(1)
  })

  it("re-arms instead of sending the delta twice while a publish is in flight", async () => {
    let finish: (outcome: FeedPublishOutcome) => void = () => {}
    publisher = new AccountStatePublisher({
      publishDelta: () => {
        deltas++
      },
      publishToFeed: (reason) => {
        feedCalls.push(reason)
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    publisher.schedule("change")
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS)
    publisher.schedule("change")
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS)

    expect(deltas).toBe(1)
    expect(feedCalls).toEqual(["change"])

    finish({ status: "published" })
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS)
    expect(deltas).toBe(2)
  })

  it("retries a partial publish with backoff until one lands", async () => {
    outcomes = [PARTIAL, PARTIAL]
    publisher.schedule("acquired")
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS)
    expect(feedCalls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(
      rosterRetryDelayMs(0) + PUBLISH_DEBOUNCE_MS,
    )
    expect(feedCalls).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(
      rosterRetryDelayMs(1) + PUBLISH_DEBOUNCE_MS,
    )
    expect(feedCalls).toEqual(["acquired", "acquired", "acquired"])

    await vi.advanceTimersByTimeAsync(
      rosterRetryDelayMs(2) + PUBLISH_DEBOUNCE_MS,
    )
    expect(feedCalls).toHaveLength(3)
  })

  it("starts the backoff over after a publish lands", async () => {
    outcomes = [PARTIAL, { status: "published" }, PARTIAL]
    publisher.schedule("acquired")
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(
      rosterRetryDelayMs(0) + PUBLISH_DEBOUNCE_MS,
    )
    expect(feedCalls).toHaveLength(2)

    publisher.schedule("change")
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS)
    expect(feedCalls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(
      rosterRetryDelayMs(0) + PUBLISH_DEBOUNCE_MS,
    )
    expect(feedCalls).toHaveLength(4)
  })

  it("drops a scheduled publish and a pending retry on cancel", async () => {
    outcomes = [PARTIAL]
    publisher.schedule("acquired")
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS)
    publisher.cancel()
    publisher.schedule("acquired")
    publisher.cancel()

    await vi.advanceTimersByTimeAsync(
      rosterRetryDelayMs(0) + PUBLISH_DEBOUNCE_MS,
    )
    expect(feedCalls).toHaveLength(1)
  })

  it("survives a publish that throws", async () => {
    publisher = new AccountStatePublisher({
      publishDelta: () => {},
      publishToFeed: async (reason) => {
        feedCalls.push(reason)
        if (feedCalls.length === 1) throw new Error("bee down")
        return { status: "published" }
      },
    })
    publisher.schedule("acquired")
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS)
    publisher.schedule("acquired")
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS)

    expect(feedCalls).toHaveLength(2)
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest"
import type { Tag } from "@ethersphere/bee-js"
import { MockBee } from "../proxy/feeds/epochs/test-utils"
import { tryCreateTag } from "./tag"

const tag = (uid: number): Tag => ({
  uid,
  split: 0,
  seen: 0,
  stored: 0,
  sent: 0,
  synced: 0,
  address: "",
  startedAt: "",
})

/** A `MockBee` whose `createTag` is a spy the test scripts and counts. */
function beeWithTagSpy() {
  const bee = new MockBee()
  const createTag = vi.spyOn(bee, "createTag")
  return { bee, createTag }
}

describe("tryCreateTag", () => {
  it("should return tag uid on success", async () => {
    const { bee, createTag } = beeWithTagSpy()
    createTag.mockResolvedValue(tag(42))

    const result = await tryCreateTag(bee)
    expect(result).toBe(42)
  })

  it("should return undefined when createTag throws", async () => {
    const { bee, createTag } = beeWithTagSpy()
    createTag.mockRejectedValue(
      new Error("Request failed with status code 404"),
    )

    const result = await tryCreateTag(bee)
    expect(result).toBeUndefined()
  })

  it("should log a warning when createTag fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { bee, createTag } = beeWithTagSpy()
    createTag.mockRejectedValue(new Error("404"))

    await tryCreateTag(bee)
    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it("caches the 404 verdict per Bee — does not re-POST /tags on the same node", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { bee, createTag } = beeWithTagSpy()
    createTag.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    )

    expect(await tryCreateTag(bee)).toBeUndefined()
    expect(await tryCreateTag(bee)).toBeUndefined()
    expect(await tryCreateTag(bee)).toBeUndefined()
    // Only the first call hits the network; the rest short-circuit on the cache.
    expect(createTag).toHaveBeenCalledTimes(1)
  })

  it("does NOT cache a transient failure whose message merely contains '404'", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    // A real 5xx whose body/message happens to mention 404 must NOT be read as
    // "tags unsupported" — only the response STATUS (BeeResponseError.status)
    // decides. A message-substring heuristic would poison the cache here.
    const { bee, createTag } = beeWithTagSpy()
    createTag
      .mockRejectedValueOnce(
        Object.assign(new Error("Bee returned 500; upstream said 404"), {
          status: 500,
        }),
      )
      .mockResolvedValueOnce(tag(11))

    expect(await tryCreateTag(bee)).toBeUndefined()
    // Not cached → the next upload re-probes and succeeds.
    expect(await tryCreateTag(bee)).toBe(11)
    expect(createTag).toHaveBeenCalledTimes(2)
  })

  it("does NOT cache a transient (non-404) failure — re-probes on the next upload", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { bee, createTag } = beeWithTagSpy()
    createTag
      .mockRejectedValueOnce(new Error("Request failed with status code 500"))
      .mockResolvedValueOnce(tag(9))

    // A transient 5xx yields undefined this time, but must NOT poison the cache.
    expect(await tryCreateTag(bee)).toBeUndefined()
    // So the next upload re-probes the node and succeeds.
    expect(await tryCreateTag(bee)).toBe(9)
    expect(createTag).toHaveBeenCalledTimes(2)
  })

  it("keeps the verdict per-Bee — a different node re-probes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const gateway = beeWithTagSpy()
    gateway.createTag.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    )
    const realNode = beeWithTagSpy()
    realNode.createTag.mockResolvedValue(tag(7))

    await tryCreateTag(gateway.bee)
    await tryCreateTag(gateway.bee)
    // A separate Bee instance is unaffected by the gateway's cached verdict.
    expect(await tryCreateTag(realNode.bee)).toBe(7)
  })
})

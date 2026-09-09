// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest"
import type { Bee, Tag } from "@ethersphere/bee-js"
import { tryCreateTag } from "./tag"

/** A `createTag` mock with Bee's own signature, so what it resolves is a `Tag`. */
const createTagMock = () => vi.fn<Bee["createTag"]>()

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

describe("tryCreateTag", () => {
  it("should return tag uid on success", async () => {
    const mockBee = {
      createTag: createTagMock().mockResolvedValue(tag(42)),
    }

    const result = await tryCreateTag(mockBee)
    expect(result).toBe(42)
  })

  it("should return undefined when createTag throws", async () => {
    const mockBee = {
      createTag: createTagMock().mockRejectedValue(
        new Error("Request failed with status code 404"),
      ),
    }

    const result = await tryCreateTag(mockBee)
    expect(result).toBeUndefined()
  })

  it("should log a warning when createTag fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const mockBee = {
      createTag: createTagMock().mockRejectedValue(new Error("404")),
    }

    await tryCreateTag(mockBee)
    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it("caches the 404 verdict per Bee — does not re-POST /tags on the same node", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const bee = {
      createTag: createTagMock().mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: 404 }),
      ),
    }

    expect(await tryCreateTag(bee)).toBeUndefined()
    expect(await tryCreateTag(bee)).toBeUndefined()
    expect(await tryCreateTag(bee)).toBeUndefined()
    // Only the first call hits the network; the rest short-circuit on the cache.
    expect(bee.createTag).toHaveBeenCalledTimes(1)
  })

  it("does NOT cache a transient failure whose message merely contains '404'", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    // A real 5xx whose body/message happens to mention 404 must NOT be read as
    // "tags unsupported" — only the response STATUS (BeeResponseError.status)
    // decides. A message-substring heuristic would poison the cache here.
    const createTag = createTagMock()
      .mockRejectedValueOnce(
        Object.assign(new Error("Bee returned 500; upstream said 404"), {
          status: 500,
        }),
      )
      .mockResolvedValueOnce(tag(11))
    const bee = { createTag }

    expect(await tryCreateTag(bee)).toBeUndefined()
    // Not cached → the next upload re-probes and succeeds.
    expect(await tryCreateTag(bee)).toBe(11)
    expect(createTag).toHaveBeenCalledTimes(2)
  })

  it("does NOT cache a transient (non-404) failure — re-probes on the next upload", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const createTag = createTagMock()
      .mockRejectedValueOnce(new Error("Request failed with status code 500"))
      .mockResolvedValueOnce(tag(9))
    const bee = { createTag }

    // A transient 5xx yields undefined this time, but must NOT poison the cache.
    expect(await tryCreateTag(bee)).toBeUndefined()
    // So the next upload re-probes the node and succeeds.
    expect(await tryCreateTag(bee)).toBe(9)
    expect(createTag).toHaveBeenCalledTimes(2)
  })

  it("keeps the verdict per-Bee — a different node re-probes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const gateway = {
      createTag: createTagMock().mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: 404 }),
      ),
    }
    const realNode = {
      createTag: createTagMock().mockResolvedValue(tag(7)),
    }

    await tryCreateTag(gateway)
    await tryCreateTag(gateway)
    // A separate Bee instance is unaffected by the gateway's cached verdict.
    expect(await tryCreateTag(realNode)).toBe(7)
  })
})

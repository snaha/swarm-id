// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest"
import type { Bee } from "@ethersphere/bee-js"
import { tryCreateTag } from "./tag"

describe("tryCreateTag", () => {
  it("should return tag uid on success", async () => {
    const mockBee = {
      createTag: vi.fn().mockResolvedValue({ uid: 42 }),
    } as unknown as Bee

    const result = await tryCreateTag(mockBee)
    expect(result).toBe(42)
  })

  it("should return undefined when createTag throws", async () => {
    const mockBee = {
      createTag: vi
        .fn()
        .mockRejectedValue(new Error("Request failed with status code 404")),
    } as unknown as Bee

    const result = await tryCreateTag(mockBee)
    expect(result).toBeUndefined()
  })

  it("should log a warning when createTag fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const mockBee = {
      createTag: vi.fn().mockRejectedValue(new Error("404")),
    } as unknown as Bee

    await tryCreateTag(mockBee)
    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it("caches the 404 verdict per Bee — does not re-POST /tags on the same node", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const bee = {
      createTag: vi.fn().mockRejectedValue(new Error("404")),
    } as unknown as Bee

    expect(await tryCreateTag(bee)).toBeUndefined()
    expect(await tryCreateTag(bee)).toBeUndefined()
    expect(await tryCreateTag(bee)).toBeUndefined()
    // Only the first call hits the network; the rest short-circuit on the cache.
    expect(
      (bee as unknown as { createTag: ReturnType<typeof vi.fn> }).createTag,
    ).toHaveBeenCalledTimes(1)
  })

  it("keeps the verdict per-Bee — a different node re-probes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const gateway = {
      createTag: vi.fn().mockRejectedValue(new Error("404")),
    } as unknown as Bee
    const realNode = {
      createTag: vi.fn().mockResolvedValue({ uid: 7 }),
    } as unknown as Bee

    await tryCreateTag(gateway)
    await tryCreateTag(gateway)
    // A separate Bee instance is unaffected by the gateway's cached verdict.
    expect(await tryCreateTag(realNode)).toBe(7)
  })
})

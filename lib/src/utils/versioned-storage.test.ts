// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { z } from "zod"
import {
  VersionedStorageManager,
  MemoryStorageAdapter,
  createZodParser,
  type StorageAdapter,
} from "./versioned-storage"

interface Item {
  name: string
}

const ItemsSchema = z.array(z.object({ name: z.string() }))

function makeManager(
  storage: StorageAdapter,
  key = "test-key",
): VersionedStorageManager<Item> {
  return new VersionedStorageManager<Item>({
    key,
    currentVersion: 1,
    storage,
    parsers: { 1: createZodParser(ItemsSchema) },
  })
}

describe("VersionedStorageManager — same-window change notification", () => {
  // The browser's `storage` event only fires in OTHER windows. Two manager
  // instances living in the SAME window (e.g. the ui accounts store and the
  // SwarmIdProxy inside the proxy iframe) must still see each other's writes,
  // so `save()` broadcasts a window-scoped event that other instances relay
  // to their subscribers.
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("notifies another instance's subscribers on save", () => {
    const storage = new MemoryStorageAdapter()
    const writer = makeManager(storage)
    const reader = makeManager(storage)

    const seen: Item[][] = []
    reader.subscribe((data) => seen.push(data))

    writer.save([{ name: "x" }])

    expect(seen).toEqual([[{ name: "x" }]])
  })

  it("does not notify the writing instance's own subscribers", () => {
    const storage = new MemoryStorageAdapter()
    const writer = makeManager(storage)

    const seen: Item[][] = []
    writer.subscribe((data) => seen.push(data))

    writer.save([{ name: "x" }])

    expect(seen).toEqual([])
  })

  it("does not notify subscribers of a different key", () => {
    const storage = new MemoryStorageAdapter()
    const writer = makeManager(storage, "key-a")
    const reader = makeManager(storage, "key-b")

    const seen: Item[][] = []
    reader.subscribe((data) => seen.push(data))

    writer.save([{ name: "x" }])

    expect(seen).toEqual([])
  })

  it("notifies other instances on clear", () => {
    const storage = new MemoryStorageAdapter()
    const writer = makeManager(storage)
    const reader = makeManager(storage)
    writer.save([{ name: "x" }])

    const seen: Item[][] = []
    reader.subscribe((data) => seen.push(data))

    writer.clear()

    expect(seen).toEqual([[]])
  })

  it("stops notifying after unsubscribe", () => {
    const storage = new MemoryStorageAdapter()
    const writer = makeManager(storage)
    const reader = makeManager(storage)

    const seen: Item[][] = []
    const unsubscribe = reader.subscribe((data) => seen.push(data))
    unsubscribe()

    writer.save([{ name: "x" }])

    expect(seen).toEqual([])
  })

  it("save does not throw outside a window environment", () => {
    vi.unstubAllGlobals()
    const storage = new MemoryStorageAdapter()
    const writer = makeManager(storage)

    expect(() => writer.save([{ name: "x" }])).not.toThrow()
  })
})

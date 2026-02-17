/**
 * Integration tests for sequential feeds
 *
 * Based on the Go implementation tests from bee/pkg/feeds/sequence
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { Bee } from "@ethersphere/bee-js"
import { SyncSequentialFinder } from "./finder"
import { AsyncSequentialFinder } from "./async-finder"
import { BasicSequentialUpdater } from "./updater"
import {
  MockBee,
  MockChunkStore,
  createTestSigner,
  createTestTopic,
  createTestReference,
  createMockStamper,
  mockFetch,
} from "../epochs/test-utils"

describe("Sequential Feeds Integration", () => {
  let store: MockChunkStore
  let bee: MockBee
  let signer: ReturnType<typeof createTestSigner>
  let topic: ReturnType<typeof createTestTopic>
  let stamper: ReturnType<typeof createMockStamper>

  beforeEach(() => {
    store = new MockChunkStore()
    bee = new MockBee(store)
    signer = createTestSigner()
    topic = createTestTopic()
    stamper = createMockStamper()
    mockFetch(store, signer.publicKey().address())
  })

  afterEach(() => {
    store.clear()
  })

  it("should return undefined when no updates exist", async () => {
    const owner = signer.publicKey().address()
    const beeClient = bee as unknown as Bee
    const finder = new SyncSequentialFinder(beeClient, topic, owner)

    const result = await finder.findAt(0n, 0n)
    expect(result.current).toBeUndefined()
    expect(result.next).toBe(0n)
  })

  it("should store and retrieve latest update index", async () => {
    const beeClient = bee as unknown as Bee
    const updater = new BasicSequentialUpdater(beeClient, topic, signer)
    const owner = updater.getOwner()
    const finder = new SyncSequentialFinder(beeClient, topic, owner)

    const updates = 5
    for (let i = 0; i < updates; i++) {
      await updater.update(createTestReference(i), stamper)
    }

    const result = await finder.findAt(0n, 0n)
    expect(result.current).toBe(BigInt(updates - 1))
    expect(result.next).toBe(BigInt(updates))
  })

  it("async finder should match sync finder", async () => {
    const beeClient = bee as unknown as Bee
    const updater = new BasicSequentialUpdater(beeClient, topic, signer)
    const owner = updater.getOwner()
    const syncFinder = new SyncSequentialFinder(beeClient, topic, owner)
    const asyncFinder = new AsyncSequentialFinder(beeClient, topic, owner)

    const updates = 3
    for (let i = 0; i < updates; i++) {
      await updater.update(createTestReference(i), stamper)
    }

    const syncResult = await syncFinder.findAt(0n, 0n)
    const asyncResult = await asyncFinder.findAt(0n, 0n)

    expect(asyncResult.current).toBe(syncResult.current)
    expect(asyncResult.next).toBe(syncResult.next)
  })
})

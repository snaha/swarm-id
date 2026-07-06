// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { Binary } from "cafe-utility"
import { EthAddress, Topic } from "@ethersphere/bee-js"
import { SyncSequentialFinder } from "./finder"

const OWNER = new EthAddress("a".repeat(40))

// Replicate the module-private address derivation so the fake bee can reverse-map
// a requested chunk address back to its sequence index.
function addrForIndex(topic: Topic, index: bigint): string {
  const indexBytes = Binary.numberToUint64(index, "BE")
  const identifier = Binary.keccak256(
    Binary.concatBytes(topic.toUint8Array(), indexBytes),
  )
  const address = Binary.keccak256(
    Binary.concatBytes(identifier, OWNER.toUint8Array()),
  )
  return Binary.uint8ArrayToHex(address)
}

// Bee's /chunks endpoint returns 500 for a genuinely-absent chunk, so a miss is
// a 500 here (NOT a 404). A transient failure is indistinguishable by status.
function notFound500(): Error {
  return Object.assign(new Error("read chunk failed"), { status: 500 })
}

/**
 * Fake bee serving sequential SOCs. `present` indices resolve; `failTimes` maps
 * an index to how many leading reads throw before it resolves (models a
 * transient blip on an existing chunk). Missing indices always throw.
 */
function fakeBee(opts: {
  topic: Topic
  present: Set<number>
  failTimes?: Map<number, number>
}): { downloads: number; bee: unknown } {
  const addrToIndex = new Map<string, number>()
  for (let i = 0; i < 64; i++)
    addrToIndex.set(addrForIndex(opts.topic, BigInt(i)), i)
  const calls = new Map<number, number>()
  const state = { downloads: 0 }
  const bee = {
    downloadChunk: async (hex: string) => {
      state.downloads++
      const index = addrToIndex.get(hex.toLowerCase())
      if (index === undefined) throw notFound500()
      const n = (calls.get(index) ?? 0) + 1
      calls.set(index, n)
      const fails = opts.failTimes?.get(index) ?? 0
      if (n <= fails) throw notFound500()
      if (!opts.present.has(index)) throw notFound500()
      return new Uint8Array(32)
    },
  }
  return {
    get downloads() {
      return state.downloads
    },
    bee,
  }
}

describe("SyncSequentialFinder — retry-then-conclude (anti-clobber)", () => {
  it("reads a contiguous feed and returns the tail index", async () => {
    const topic = Topic.fromString("seq-a")
    const { bee } = fakeBee({ topic, present: new Set([0, 1, 2]) })
    const finder = new SyncSequentialFinder(bee as never, topic, OWNER)
    const result = await finder.findAt(0n)
    expect(result.current).toBe(2n)
    expect(result.next).toBe(3n)
  })

  it("treats a slot that fails once then succeeds as PRESENT (not a free slot)", async () => {
    // Index 1 blips on its first read. Without the retry, the scan would stop at
    // 1 and hand back next=1, clobbering the existing entry there. With retry it
    // recovers and continues to the true tail.
    const topic = Topic.fromString("seq-b")
    const { bee } = fakeBee({
      topic,
      present: new Set([0, 1, 2]),
      failTimes: new Map([[1, 1]]),
    })
    const finder = new SyncSequentialFinder(bee as never, topic, OWNER)
    const result = await finder.findAt(0n)
    expect(result.next).toBe(3n)
  })

  it("concludes a slot free only after BOTH reads fail (exactly two reads)", async () => {
    const topic = Topic.fromString("seq-c")
    const fake = fakeBee({ topic, present: new Set() }) // empty feed
    const finder = new SyncSequentialFinder(fake.bee as never, topic, OWNER)
    const result = await finder.findAt(0n)
    expect(result.current).toBeUndefined()
    expect(result.next).toBe(0n)
    // index 0 read twice (initial + one retry) before concluding free.
    expect(fake.downloads).toBe(2)
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `AsyncEpochFinder.findAt` probing behaviour (#400): the exact-timestamp
 * fast-path probe must not run in SERIES before the tree traversal — on a
 * "latest as of now" read (every fold) it never hits and would otherwise cost a
 * full absent-chunk timeout before the traversal even starts. Its result
 * preference is unchanged: an exact hit wins even when the traversal finds
 * nothing (poisoned-ancestor recovery, the reason the fast path exists).
 */

import { describe, it, expect, vi } from "vitest"
import { EthAddress, Reference, Topic } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { AsyncEpochFinder } from "./async-finder"
import { EpochIndex, MAX_LEVEL } from "./epoch"

const TOPIC = Topic.fromString("async-finder-test")
const OWNER = new EthAddress("a".repeat(40))
const AT = 1_700_000_000n

/** The chunk address `getEpochChunk` computes for an epoch of our topic/owner. */
async function epochAddressHex(epoch: EpochIndex): Promise<string> {
  const epochHash = await epoch.marshalBinary()
  const identifier = Binary.keccak256(
    Binary.concatBytes(TOPIC.toUint8Array(), epochHash),
  )
  return new Reference(
    Binary.keccak256(Binary.concatBytes(identifier, OWNER.toUint8Array())),
  ).toHex()
}

/** A minimal unencrypted SOC feed chunk: 40-byte payload = ts(8 BE) + ref(32). */
function socChunk(timestamp: bigint, ref: Uint8Array): Uint8Array {
  const IDENTIFIER_SIZE = 32
  const SIGNATURE_SIZE = 65
  const SPAN_SIZE = 8
  const TIMESTAMP_SIZE = 8
  const PAYLOAD_LENGTH = TIMESTAMP_SIZE + ref.length
  const spanStart = IDENTIFIER_SIZE + SIGNATURE_SIZE
  const chunk = new Uint8Array(spanStart + SPAN_SIZE + PAYLOAD_LENGTH)
  const view = new DataView(chunk.buffer)
  view.setBigUint64(spanStart, BigInt(PAYLOAD_LENGTH), true) // span, LE
  view.setBigUint64(spanStart + SPAN_SIZE, timestamp, false) // timestamp, BE
  chunk.set(ref, spanStart + SPAN_SIZE + TIMESTAMP_SIZE)
  return chunk
}

function notFound(): Error {
  return Object.assign(new Error("chunk not found"), { status: 404 })
}

describe("AsyncEpochFinder — exact probe does not gate the traversal (#400)", () => {
  it("issues the root traversal before the exact-timestamp probe settles", async () => {
    const exactAddr = await epochAddressHex(new EpochIndex(AT, 0))
    const rootAddr = await epochAddressHex(new EpochIndex(0n, MAX_LEVEL))
    const requested: string[] = []
    let failExact!: () => void
    const exactGate = new Promise<Uint8Array>((_, reject) => {
      failExact = () => reject(notFound())
    })
    const bee = {
      downloadChunk: (addr: string) => {
        requested.push(addr)
        if (addr === exactAddr) return exactGate // gateway still probing peers
        return Promise.reject(notFound())
      },
    }

    const finder = new AsyncEpochFinder(bee as never, TOPIC, OWNER)
    const pending = finder.findAt(AT)
    // The root request must go out while the exact probe is still in flight.
    await vi.waitFor(() => expect(requested).toContain(rootAddr))
    failExact()
    await expect(pending).resolves.toBeUndefined()
  })

  it("an exact hit wins even when the traversal finds nothing (poisoned ancestors)", async () => {
    const exactAddr = await epochAddressHex(new EpochIndex(AT, 0))
    const ref = new Uint8Array(32).fill(7)
    const bee = {
      downloadChunk: async (addr: string) => {
        if (addr === exactAddr) return socChunk(AT, ref)
        throw notFound() // every ancestor missing
      },
    }
    const result = await new AsyncEpochFinder(
      bee as never,
      TOPIC,
      OWNER,
    ).findAt(AT)
    expect(result).toEqual(ref)
  })

  it("an exact miss falls back to the traversal's result", async () => {
    const rootAddr = await epochAddressHex(new EpochIndex(0n, MAX_LEVEL))
    const ref = new Uint8Array(32).fill(9)
    const bee = {
      downloadChunk: async (addr: string) => {
        if (addr === rootAddr) return socChunk(AT - 100n, ref)
        throw notFound()
      },
    }
    const result = await new AsyncEpochFinder(
      bee as never,
      TOPIC,
      OWNER,
    ).findAt(AT)
    expect(result).toEqual(ref)
  })
})

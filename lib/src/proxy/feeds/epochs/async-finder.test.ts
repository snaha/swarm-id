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
import { PrivateKey, Topic } from "@ethersphere/bee-js"
import { makeContentAddressedChunk } from "@ethersphere/core-sdk"
import { AsyncEpochFinder } from "./async-finder"
import { EpochIndex, MAX_LEVEL } from "./epoch"
import { epochSocAddress } from "./updater"
import { makeEpochIdentifier } from "./utils"
import { uint8ArrayToHex } from "../../../utils/hex"

const TOPIC = Topic.fromString("async-finder-test")
const SIGNER = new PrivateKey("22".repeat(32))
const OWNER = SIGNER.publicKey().address()
const AT = 1_700_000_000n
const TIMESTAMP_SIZE = 8

/** The chunk address `getEpochChunk` computes for an epoch of our topic/owner. */
async function epochAddressHex(epoch: EpochIndex): Promise<string> {
  return uint8ArrayToHex(await epochSocAddress(TOPIC, epoch, OWNER))
}

/** A signed SOC feed entry for `epoch`: 40-byte payload = ts(8 BE) + ref(32). */
async function socChunk(
  epoch: EpochIndex,
  timestamp: bigint,
  ref: Uint8Array,
): Promise<Uint8Array> {
  const payload = new Uint8Array(TIMESTAMP_SIZE + ref.length)
  new DataView(payload.buffer).setBigUint64(0, timestamp, false)
  payload.set(ref, TIMESTAMP_SIZE)
  const identifier = await makeEpochIdentifier(TOPIC, epoch)
  return makeContentAddressedChunk(payload).toSingleOwnerChunk(
    identifier,
    SIGNER,
  ).data
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
      chunk: {
        download: (addr: string) => {
          requested.push(addr)
          if (addr === exactAddr) return exactGate // gateway still probing peers
          return Promise.reject(notFound())
        },
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
    const exactEpoch = new EpochIndex(AT, 0)
    const exactAddr = await epochAddressHex(exactEpoch)
    const ref = new Uint8Array(32).fill(7)
    const bee = {
      chunk: {
        download: async (addr: string) => {
          if (addr === exactAddr) return socChunk(exactEpoch, AT, ref)
          throw notFound() // every ancestor missing
        },
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
    const rootEpoch = new EpochIndex(0n, MAX_LEVEL)
    const rootAddr = await epochAddressHex(rootEpoch)
    const ref = new Uint8Array(32).fill(9)
    const bee = {
      chunk: {
        download: async (addr: string) => {
          if (addr === rootAddr) return socChunk(rootEpoch, AT - 100n, ref)
          throw notFound()
        },
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

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * How both epoch finders read one entry off the plain (unencrypted) path: the
 * payload layouts they accept, and the ones they reject. The SOCs are signed
 * for real, as Bee would serve them, and one signed by anyone but the feed's
 * owner is not an entry: a gateway serves whatever bytes it holds.
 */

import { describe, it, expect } from "vitest"
import { PrivateKey, Topic } from "@ethersphere/bee-js"
import { makeContentAddressedChunk } from "@ethersphere/core-sdk"
import { AsyncEpochFinder } from "./async-finder"
import { EpochIndex } from "./epoch"
import { SyncEpochFinder } from "./finder"
import type { EpochFinder } from "./types"
import { epochSocAddress } from "./updater"
import { makeEpochIdentifier } from "./utils"
import { uint8ArrayToHex } from "../../../utils/hex"

const TOPIC = Topic.fromString("epoch-finder-payload")
const SIGNER = new PrivateKey("11".repeat(32))
const IMPOSTOR_KEY = "33".repeat(32)
const OWNER = SIGNER.publicKey().address()
const AT = 1_700_000_000n
const TIMESTAMP_SIZE = 8
const SPAN_SIZE = 8
const PLAIN_REF_SIZE = 32
const ENCRYPTED_REF_SIZE = 64
const MALFORMED_PAYLOAD_SIZE = 41
const FILL = 7

type FinderFactory = (bee: never) => EpochFinder

const FINDERS: [string, FinderFactory][] = [
  ["SyncEpochFinder", (bee) => new SyncEpochFinder(bee, TOPIC, OWNER)],
  ["AsyncEpochFinder", (bee) => new AsyncEpochFinder(bee, TOPIC, OWNER)],
]

function notFound(): Error {
  return Object.assign(new Error("chunk not found"), { status: 404 })
}

/** `[span(8 LE)] ‖ timestamp(8 BE) ‖ reference`, the span prefix optional. */
function feedPayload(
  timestamp: bigint,
  reference: Uint8Array,
  spanPrefix: boolean,
): Uint8Array {
  const prefix = spanPrefix ? SPAN_SIZE : 0
  const payload = new Uint8Array(prefix + TIMESTAMP_SIZE + reference.length)
  const view = new DataView(payload.buffer)
  if (spanPrefix) {
    view.setBigUint64(0, BigInt(TIMESTAMP_SIZE + reference.length), true)
  }
  view.setBigUint64(prefix, timestamp, false)
  payload.set(reference, prefix + TIMESTAMP_SIZE)
  return payload
}

/** A Bee with one SOC, signed by `signer`, stored at the exact epoch of `AT`. */
async function beeWithEntry(
  payload: Uint8Array,
  signer: PrivateKey = SIGNER,
): Promise<never> {
  const epoch = new EpochIndex(AT, 0)
  const identifier = await makeEpochIdentifier(TOPIC, epoch)
  const soc = makeContentAddressedChunk(payload).toSingleOwnerChunk(
    identifier,
    signer,
  )
  const address = uint8ArrayToHex(await epochSocAddress(TOPIC, epoch, OWNER))
  const bee = {
    chunk: {
      download: async (addr: string) => {
        if (addr === address) return soc.data
        throw notFound()
      },
    },
  }
  return bee as never
}

describe.each(FINDERS)("%s — plain entry payload", (_, makeFinder) => {
  it.each([
    ["timestamp ‖ reference", PLAIN_REF_SIZE, false],
    ["span ‖ timestamp ‖ reference", PLAIN_REF_SIZE, true],
    ["timestamp ‖ encrypted reference", ENCRYPTED_REF_SIZE, false],
    ["span ‖ timestamp ‖ encrypted reference", ENCRYPTED_REF_SIZE, true],
  ])("reads %s", async (_layout, refSize, spanPrefix) => {
    const reference = new Uint8Array(refSize).fill(FILL)
    const bee = await beeWithEntry(feedPayload(AT, reference, spanPrefix))
    expect(await makeFinder(bee).findAt(AT)).toEqual(reference)
  })

  it("skips an entry written after the requested time", async () => {
    const reference = new Uint8Array(PLAIN_REF_SIZE).fill(FILL)
    const bee = await beeWithEntry(feedPayload(AT + 1n, reference, false))
    expect(await makeFinder(bee).findAt(AT)).toBeUndefined()
  })

  it("skips an entry at the owner's address signed by another key", async () => {
    const reference = new Uint8Array(PLAIN_REF_SIZE).fill(FILL)
    const bee = await beeWithEntry(
      feedPayload(AT, reference, false),
      new PrivateKey(IMPOSTOR_KEY),
    )
    expect(await makeFinder(bee).findAt(AT)).toBeUndefined()
  })

  it("skips a payload of no known length", async () => {
    const bee = await beeWithEntry(new Uint8Array(MALFORMED_PAYLOAD_SIZE))
    expect(await makeFinder(bee).findAt(AT)).toBeUndefined()
  })
})

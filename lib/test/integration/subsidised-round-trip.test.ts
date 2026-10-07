// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Subsidised mode against a real gateway (`test/integration/gateway.ts`).
 *
 * This is the one upload path the library does not stamp: it POSTs bare chunks
 * and SOCs and lets the gateway inject `swarm-postage-batch-id`. Everything
 * that can go wrong there is on the wire — a header the gateway strips, an
 * endpoint it stopped proxying, a body shape it rejects — so a mocked gateway
 * would only ever confirm our own assumptions back to us.
 *
 * Every read goes to the QUEEN, not back through the gateway: that is what
 * separates "the gateway accepted it" from "it was stamped and reached the
 * network".
 */

import { describe, it, expect, beforeAll } from "vitest"
import { Identifier, PrivateKey, type Bee } from "@ethersphere/bee-js"
import {
  uploadData,
  uploadSOC,
  type UploadTarget,
} from "../../src/proxy/upload"
import {
  downloadDataWithChunkAPI,
  downloadSOC,
} from "../../src/proxy/download-data"
import { createQueenBee } from "./cluster"
import { createSubsidisedTarget } from "./gateway"

/** Generate a unique random payload so each test is independent. */
function randomPayload(size: number): Uint8Array {
  const data = new Uint8Array(size)
  crypto.getRandomValues(data)
  return data
}

const SMALL_PAYLOAD_SIZE = 64
const MULTI_CHUNK_PAYLOAD_SIZE = 10_000
const SOC_PAYLOAD_SIZE = 32

describe("Subsidised-gateway round-trip against live cluster", () => {
  let bee: Bee
  let target: UploadTarget

  beforeAll(() => {
    bee = createQueenBee()
    target = createSubsidisedTarget()
  })

  it("uploads and downloads small plain data", async () => {
    const data = randomPayload(SMALL_PAYLOAD_SIZE)

    const { reference } = await uploadData(target, data)
    expect(reference).toMatch(/^[0-9a-f]{64}$/)

    expect(await downloadDataWithChunkAPI(bee, reference)).toEqual(data)
  })

  // The merkle-tree branch: intermediate chunks are POSTed to the gateway too,
  // so a gateway that stamps leaves but not the tree fails only here.
  it("uploads and downloads multi-chunk plain data", async () => {
    const data = randomPayload(MULTI_CHUNK_PAYLOAD_SIZE)

    const { reference } = await uploadData(target, data)

    expect(await downloadDataWithChunkAPI(bee, reference)).toEqual(data)
  })

  // The second endpoint: `POST /soc/{owner}/{id}?sig=…`, signed here and
  // stamped there. Reading it back from the queen proves the signature
  // survived the proxy hop intact.
  it("uploads a single-owner chunk the queen serves back", async () => {
    const signer = new PrivateKey(randomPayload(32))
    const identifier = new Identifier(randomPayload(32))
    const data = randomPayload(SOC_PAYLOAD_SIZE)

    await uploadSOC(target, signer, identifier, data)

    const soc = await downloadSOC(bee, signer.publicKey().address(), identifier)
    expect(soc.payload).toEqual(data)
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The subsidised path never sends `Swarm-Pin` (#752): pinning means "keep
 * this on the local node", and the node is the dApp operator's, not the
 * user's — gateway-proxy strips the header by default, and the public
 * gateway's CORS preflight rejects it outright, as a bare "Failed to fetch".
 *
 * Stamper mode still sends it — the node is the user's own — so the positive
 * half is asserted too, or a header dropped from the wrong branch stays green.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { PrivateKey, Identifier } from "@ethersphere/bee-js"
import { uploadChunk, uploadData, uploadSOC, type UploadTarget } from "./upload"
import { MockBee, createMockStamper } from "./feeds/epochs/test-utils"

const GATEWAY = "https://gateway.example"
const TARGET: UploadTarget = { mode: "subsidised", gatewayUrl: GATEWAY }
const REFERENCE = "ab".repeat(32)
const TAG_UID = 7

const signer = new PrivateKey(new Uint8Array(32).fill(1))
const identifier = new Identifier(new Uint8Array(32))

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ reference: REFERENCE })),
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

/** Header names of every request the stub saw, lowercased so a casing
 *  change in the code cannot make a `not.toContain` pass vacuously. */
function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.flatMap(([, init]) =>
    Object.keys((init as RequestInit).headers as Record<string, string>).map(
      (name) => name.toLowerCase(),
    ),
  )
}

function stamperTarget(bee: MockBee): UploadTarget {
  return { mode: "stamper", bee, stamper: createMockStamper() }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("subsidised uploads omit swarm-pin", () => {
  it("on a chunk", async () => {
    const fetchMock = stubFetch()
    await uploadChunk(TARGET, new Uint8Array(16), { pin: true })
    expect(fetchMock).toHaveBeenCalled()
    expect(sentHeaders(fetchMock)).not.toContain("swarm-pin")
  })

  it("on data", async () => {
    const fetchMock = stubFetch()
    await uploadData(TARGET, new Uint8Array(16), { pin: true })
    expect(fetchMock).toHaveBeenCalled()
    expect(sentHeaders(fetchMock)).not.toContain("swarm-pin")
  })

  it("on a SOC", async () => {
    const fetchMock = stubFetch()
    await uploadSOC(TARGET, signer, identifier, new Uint8Array(16), {
      pin: true,
    })
    expect(fetchMock).toHaveBeenCalled()
    expect(sentHeaders(fetchMock)).not.toContain("swarm-pin")
  })

  it("still forward deferred, which every gateway accepts", async () => {
    const fetchMock = stubFetch()
    await uploadChunk(TARGET, new Uint8Array(16), { deferred: true })
    await uploadData(TARGET, new Uint8Array(16), { deferred: true })
    await uploadSOC(TARGET, signer, identifier, new Uint8Array(16), {
      deferred: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(
      sentHeaders(fetchMock).filter((name) => name === "swarm-deferred-upload"),
    ).toHaveLength(3)
  })
})

describe("stamper uploads keep swarm-pin", () => {
  it("on a SOC", async () => {
    const fetchMock = stubFetch()
    const target = stamperTarget(new MockBee())
    await uploadSOC(target, signer, identifier, new Uint8Array(16), {
      pin: true,
      tag: TAG_UID,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ "swarm-pin": "true" })
  })

  it("on a chunk, through bee.chunk.upload's options", async () => {
    const bee = new MockBee()
    const chunkUpload = vi.fn(bee.chunk.upload)
    bee.chunk.upload = chunkUpload

    await uploadChunk(stamperTarget(bee), new Uint8Array(16), { pin: true })

    expect(chunkUpload).toHaveBeenCalledTimes(1)
    const [, , options] = chunkUpload.mock.calls[0]
    expect(options).toMatchObject({ pin: true })
  })
})

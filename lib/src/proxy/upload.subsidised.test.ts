// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The subsidised path never sends `Swarm-Pin` (#752): pinning means "keep
 * this on the local node", and the node is the dApp operator's, not the
 * user's — gateway-proxy strips the header by default, and the public
 * gateway's CORS preflight rejects it outright, as a bare "Failed to fetch".
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { PrivateKey, Identifier } from "@ethersphere/bee-js"
import { uploadChunk, uploadData, uploadSOC, type UploadTarget } from "./upload"

const GATEWAY = "https://gateway.example"
const TARGET: UploadTarget = { mode: "subsidised", gatewayUrl: GATEWAY }
const REFERENCE = "ab".repeat(32)

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ reference: REFERENCE })),
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.flatMap(([, init]) =>
    Object.keys((init as RequestInit).headers as Record<string, string>),
  )
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
    const signer = new PrivateKey(new Uint8Array(32).fill(1))
    const identifier = new Identifier(new Uint8Array(32))
    await uploadSOC(TARGET, signer, identifier, new Uint8Array(16), {
      pin: true,
    })
    expect(fetchMock).toHaveBeenCalled()
    expect(sentHeaders(fetchMock)).not.toContain("swarm-pin")
  })

  it("still forwards deferred, which every gateway accepts", async () => {
    const fetchMock = stubFetch()
    await uploadChunk(TARGET, new Uint8Array(16), { deferred: true })
    expect(sentHeaders(fetchMock)).toContain("swarm-deferred-upload")
  })
})

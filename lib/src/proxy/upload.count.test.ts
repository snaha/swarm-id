// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every chunk an upload sends is counted on the target's counter, so
 * the proxy can tell the dApp what a write cost. The count is checked against
 * what actually left: the chunks handed to Bee in stamper mode, the requests
 * the gateway saw in subsidised mode.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { PrivateKey, Identifier } from "@ethersphere/bee-js"
import {
  uploadChunk,
  uploadData,
  uploadSOC,
  type ChunkCounter,
  type UploadTarget,
} from "./upload"
import { MockBee, createMockStamper } from "./feeds/epochs/test-utils"

const GATEWAY = "https://gateway.example"
const REFERENCE = "ab".repeat(32)
const CHUNK_PAYLOAD_SIZE = 4096
/** Three full leaves and a byte: four leaves under one intermediate chunk. */
const MULTI_CHUNK_SIZE = CHUNK_PAYLOAD_SIZE * 3 + 1

const signer = new PrivateKey(new Uint8Array(32).fill(1))
const identifier = new Identifier(new Uint8Array(32))

afterEach(() => {
  vi.unstubAllGlobals()
})

function stamper(): {
  target: UploadTarget
  counter: ChunkCounter
  sent: () => number
} {
  // A stamped SOC is a hand-rolled POST to the node, not `bee.chunk.upload`.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ reference: REFERENCE }))),
  )
  const bee = new MockBee()
  const chunkUpload = vi.fn(bee.chunk.upload)
  bee.chunk.upload = chunkUpload
  const counter: ChunkCounter = { chunks: 0 }
  return {
    target: { mode: "stamper", bee, stamper: createMockStamper(), counter },
    counter,
    sent: () => chunkUpload.mock.calls.length,
  }
}

function subsidised(): {
  target: UploadTarget
  counter: ChunkCounter
  sent: () => number
} {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ reference: REFERENCE })),
  )
  vi.stubGlobal("fetch", fetchMock)
  const counter: ChunkCounter = { chunks: 0 }
  return {
    target: { mode: "subsidised", gatewayUrl: GATEWAY, counter },
    counter,
    sent: () => fetchMock.mock.calls.length,
  }
}

describe.each([
  ["stamper", stamper],
  ["subsidised", subsidised],
])("a %s upload counts each chunk it sends", (_mode, make) => {
  it("for a single chunk", async () => {
    const { target, counter } = make()
    await uploadChunk(target, new Uint8Array(16))
    expect(counter.chunks).toBe(1)
  })

  it("for one chunk of data", async () => {
    const { target, counter } = make()
    await uploadData(target, new Uint8Array(16))
    expect(counter.chunks).toBe(1)
  })

  it("for data spanning several chunks, intermediates included", async () => {
    const { target, counter, sent } = make()
    await uploadData(target, new Uint8Array(MULTI_CHUNK_SIZE))
    expect(counter.chunks).toBe(5)
    expect(counter.chunks).toBe(sent())
  })

  it("for encrypted data spanning several chunks", async () => {
    const { target, counter, sent } = make()
    await uploadData(target, new Uint8Array(MULTI_CHUNK_SIZE), {
      encryptionKey: true,
    })
    expect(counter.chunks).toBeGreaterThan(1)
    expect(counter.chunks).toBe(sent())
  })

  it("for a SOC", async () => {
    const { target, counter } = make()
    await uploadSOC(target, signer, identifier, new Uint8Array(16))
    expect(counter.chunks).toBe(1)
  })

  it("adding up across calls on the same target", async () => {
    const { target, counter } = make()
    await uploadChunk(target, new Uint8Array(16))
    await uploadData(target, new Uint8Array(16))
    expect(counter.chunks).toBe(2)
  })
})

it("uploads without a counter on the target", async () => {
  const bee = new MockBee()
  await expect(
    uploadData(
      { mode: "stamper", bee, stamper: createMockStamper() },
      new Uint8Array(16),
    ),
  ).resolves.toBeDefined()
})

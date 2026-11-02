// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { makeEncryptedContentAddressedChunk } from "../chunk"
import { CHUNK_SIZE } from "./layout"
import { deriveUtilizationChunkKey } from "./chunk"

const TEST_BATCH_ID = new BatchId("00".repeat(32))

describe("BMT-of-encrypted chunk address (contentHash invariant)", () => {
  const KEY_A = new Uint8Array(32).map((_, i) => i + 1)
  const KEY_B = new Uint8Array(32).map((_, i) => 255 - i)

  function bmtHex(data: Uint8Array, key: Uint8Array): string {
    return Binary.uint8ArrayToHex(
      makeEncryptedContentAddressedChunk(data, key).address.toUint8Array(),
    )
  }

  it("is deterministic for the same plaintext + key", () => {
    const data = new Uint8Array(CHUNK_SIZE)
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff
    expect(bmtHex(data, KEY_A)).toBe(bmtHex(data, KEY_A))
  })

  it("changes when a single counter byte flips", () => {
    const data = new Uint8Array(CHUNK_SIZE)
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff
    const before = bmtHex(data, KEY_A)
    data[1234] ^= 0x01
    const after = bmtHex(data, KEY_A)
    expect(after).not.toBe(before)
  })

  it("changes when the encryption key changes", () => {
    const data = new Uint8Array(CHUNK_SIZE)
    for (let i = 0; i < data.length; i++) data[i] = (i * 17) & 0xff
    expect(bmtHex(data, KEY_A)).not.toBe(bmtHex(data, KEY_B))
  })

  it("returns a 64-hex-char (32-byte) address", () => {
    const data = new Uint8Array(CHUNK_SIZE)
    const hash = bmtHex(data, KEY_A)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("deriveUtilizationChunkKey", () => {
  const SWARM_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff)

  it("is deterministic for the same inputs", async () => {
    const a = await deriveUtilizationChunkKey(SWARM_KEY, TEST_BATCH_ID, 5, 0)
    const b = await deriveUtilizationChunkKey(SWARM_KEY, TEST_BATCH_ID, 5, 0)
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(a.length).toBe(32)
  })

  it("varies with chunkIndex, nonce, and batchId", async () => {
    const base = await deriveUtilizationChunkKey(SWARM_KEY, TEST_BATCH_ID, 5, 0)
    const otherIndex = await deriveUtilizationChunkKey(
      SWARM_KEY,
      TEST_BATCH_ID,
      6,
      0,
    )
    const otherNonce = await deriveUtilizationChunkKey(
      SWARM_KEY,
      TEST_BATCH_ID,
      5,
      1,
    )
    const otherBatch = await deriveUtilizationChunkKey(
      SWARM_KEY,
      new BatchId("11".repeat(32)),
      5,
      0,
    )
    expect(Array.from(base)).not.toEqual(Array.from(otherIndex))
    expect(Array.from(base)).not.toEqual(Array.from(otherNonce))
    expect(Array.from(base)).not.toEqual(Array.from(otherBatch))
  })

  it("rejects a swarmEncryptionKey of the wrong length", async () => {
    await expect(
      deriveUtilizationChunkKey(new Uint8Array(16), TEST_BATCH_ID, 0, 0),
    ).rejects.toThrow(/swarmEncryptionKey length/)
  })
})

/**
 * The partition-aware stamper is the load-bearing piece of the multi-device
 * partition-lease feature: when two devices stamp into the same shared
 * postage batch, their per-bucket slot picks MUST be drawn from disjoint
 * residue classes mod K so that no two chunks ever share a `(bucket, slot)`
 * pair. These tests pin that property.
 */

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Upload edge cases: zero-length content and explicit encryption keys.
 *
 * Zero-length content is valid on Swarm — Bee represents it as a single
 * chunk with span 0 and an empty payload, whose address is the canonical
 * empty-file reference (see bee `pkg/file/pipeline/builder` TestEmpty).
 *
 * An explicit encryption key can only apply to data that fits one chunk:
 * every chunk of a multi-chunk upload needs its own key, so passing one
 * key with larger data must fail loudly instead of being silently replaced
 * by fresh random keys (which would break deterministic addressing/dedup).
 */

import { describe, it, expect } from "vitest"
import type { Bee, Stamper } from "@ethersphere/bee-js"
import { uploadData, type UploadTarget } from "./upload"
import { downloadDataWithChunkAPI } from "./download-data"
import { CHUNK_SIZE } from "./chunking"
import {
  MockBee,
  MockChunkStore,
  createMockStamper,
} from "./feeds/epochs/test-utils"

const ENCRYPTED_REF_HEX_LEN = 128 // 32-byte address + 32-byte key

// BMT address of the span-0, empty-payload chunk — Bee's reference for
// zero-length content (pkg/file/pipeline/builder/builder_test.go TestEmpty).
const EMPTY_DATA_REFERENCE =
  "b34ca8c22b9e982354f9c7f50b470d66db428d880c8a904d5fe4ec9713171526"

/** Build `length` bytes with position-dependent variation so chunks differ. */
function makeData(length: number): Uint8Array {
  const data = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    data[i] = (i * 31 + 7) & 0xff
  }
  return data
}

function setup(): { bee: Bee; target: UploadTarget } {
  const store = new MockChunkStore()
  const bee = new MockBee(store) as unknown as Bee
  const target: UploadTarget = {
    mode: "stamper",
    bee,
    stamper: createMockStamper() as unknown as Stamper,
  }
  return { bee, target }
}

describe("uploadData with zero-length data", () => {
  it("uploads plain empty data as the canonical empty chunk", async () => {
    const { bee, target } = setup()

    const { reference } = await uploadData(target, new Uint8Array(0))
    expect(reference).toBe(EMPTY_DATA_REFERENCE)

    const downloaded = await downloadDataWithChunkAPI(bee, reference)
    expect(downloaded).toEqual(new Uint8Array(0))
  })

  it("round-trips encrypted empty data", async () => {
    const { bee, target } = setup()

    const { reference } = await uploadData(target, new Uint8Array(0), {
      encryptionKey: true,
    })
    expect(reference.length).toBe(ENCRYPTED_REF_HEX_LEN)

    const downloaded = await downloadDataWithChunkAPI(bee, reference)
    expect(downloaded).toEqual(new Uint8Array(0))
  })
})

describe("uploadData with an explicit encryption key", () => {
  const key = new Uint8Array(32).fill(7)

  it("rejects data spanning multiple chunks instead of silently ignoring the key", async () => {
    const { target } = setup()

    await expect(
      uploadData(target, makeData(CHUNK_SIZE + 1), { encryptionKey: key }),
    ).rejects.toThrow(/single-chunk/)
  })

  it("produces a deterministic reference for a full single chunk", async () => {
    // Exactly CHUNK_SIZE bytes: no random padding, so the same key must give
    // the same ciphertext and therefore the same address.
    const data = makeData(CHUNK_SIZE)

    const first = await uploadData(setup().target, data, {
      encryptionKey: key,
    })
    const second = await uploadData(setup().target, data, {
      encryptionKey: key,
    })
    expect(first.reference).toBe(second.reference)
  })

  it("embeds the provided key in the reference and round-trips a partial chunk", async () => {
    // Sub-chunk payloads are random-padded (like Bee), so the address varies
    // — but the key half of the reference must be the caller's key.
    const { bee, target } = setup()
    const data = makeData(100)

    const { reference } = await uploadData(target, data, {
      encryptionKey: key,
    })
    expect(reference.slice(64)).toBe("07".repeat(32))

    const downloaded = await downloadDataWithChunkAPI(bee, reference)
    expect(downloaded).toEqual(data)
  })
})

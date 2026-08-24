// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Upload → download round-trips for payloads large enough to build a Merkle
 * tree with ≥2 levels (more leaf chunks than one intermediate holds:
 * `PLAIN_REFS_PER_CHUNK` plain, `ENCRYPTED_REFS_PER_CHUNK` encrypted).
 *
 * These guard the span-based leaf detection on the download path against the
 * intermediate-chunk layout the upload path produces — in particular the
 * single-ref-tail case `buildEncryptedMerkleTree` passes through instead of
 * wrapping in a leaf-spanned "ghost intermediate" (see `upload.ts`). The
 * existing SOC round-trips only cover single chunks, so multi-level trees
 * were previously untested.
 *
 * In-memory only: `MockBee` persists every uploaded chunk by its address and
 * serves it back, so a stamper-mode upload needs no network / fetch mock.
 */

import { describe, it, expect } from "vitest"
import type { Bee, Stamper } from "@ethersphere/bee-js"
import { uploadData, type UploadTarget } from "./upload"
import { downloadDataWithChunkAPI } from "./download-data"
import {
  CHUNK_SIZE,
  ENCRYPTED_REFS_PER_CHUNK,
  PLAIN_REFS_PER_CHUNK,
} from "./chunking"
import {
  MockBee,
  MockChunkStore,
  createMockStamper,
} from "./feeds/epochs/test-utils"

const PLAIN_REF_HEX_LEN = 64 // 32-byte address
const ENCRYPTED_REF_HEX_LEN = 128 // 32-byte address + 32-byte key

// More than one full intermediate's worth of leaves ⇒ the tree needs a 2nd
// level. The +9 keeps the final batch comfortably multi-ref (no edge case).
const PLAIN_TWO_LEVEL_LEAF_COUNT = PLAIN_REFS_PER_CHUNK + 9
const ENCRYPTED_TWO_LEVEL_LEAF_COUNT = ENCRYPTED_REFS_PER_CHUNK + 9

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

describe("uploadData ↔ downloadDataWithChunkAPI (multi-level Merkle tree)", () => {
  it("round-trips plain data spanning ≥2 tree levels", async () => {
    const { bee, target } = setup()
    const data = makeData(PLAIN_TWO_LEVEL_LEAF_COUNT * CHUNK_SIZE)

    const { reference } = await uploadData(target, data)
    expect(reference.length).toBe(PLAIN_REF_HEX_LEN)

    const downloaded = await downloadDataWithChunkAPI(bee, reference)
    expect(downloaded).toEqual(data)
  })

  it("round-trips encrypted data spanning ≥2 tree levels", async () => {
    const { bee, target } = setup()
    const data = makeData(ENCRYPTED_TWO_LEVEL_LEAF_COUNT * CHUNK_SIZE)

    const { reference } = await uploadData(target, data, {
      encryptionKey: true,
    })
    expect(reference.length).toBe(ENCRYPTED_REF_HEX_LEN)

    const downloaded = await downloadDataWithChunkAPI(bee, reference)
    expect(downloaded).toEqual(data)
  })

  it("round-trips encrypted data whose final intermediate batch holds a single ref", async () => {
    // ENCRYPTED_REFS_PER_CHUNK + 1 leaves ⇒ intermediate batches
    // [ENCRYPTED_REFS_PER_CHUNK], [1]. The trailing single-ref batch is
    // exactly the case the span fix passes through; without it the lone ref
    // would be wrapped in a ghost intermediate whose ≤CHUNK_SIZE span the
    // downloader misreads as a leaf.
    const { bee, target } = setup()
    const data = makeData(ENCRYPTED_REFS_PER_CHUNK * CHUNK_SIZE + 1)

    const { reference } = await uploadData(target, data, {
      encryptionKey: true,
    })

    const downloaded = await downloadDataWithChunkAPI(bee, reference)
    expect(downloaded.length).toBe(data.length)
    expect(downloaded).toEqual(data)
  })
})

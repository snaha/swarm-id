// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A folder is one manifest with a fork per file (#750). The Swarm-specific
 * part — leaf references, fork metadata, the index document, the encryption
 * defaults — lives here so a dApp only has to produce `{ path, data }` pairs.
 */

import { describe, it, expect } from "vitest"
import { MantarayNode as BeeMantarayNode } from "@ethersphere/bee-js"
import { uploadCollection, listCollection } from "./collection"
import { loadMantarayTreeWithChunkAPI } from "./mantaray"
import { downloadDataWithChunkAPI } from "./download-data"
import type { UploadTarget } from "./upload"
import {
  MockBee,
  MockChunkStore,
  createMockStamper,
} from "./feeds/epochs/test-utils"

const PLAIN_REF_HEX = 64
const ENCRYPTED_REF_HEX = 128
const MULTI_CHUNK_SIZE = 5000

const text = new TextEncoder()
const FILES = [
  {
    path: "index.html",
    data: text.encode("<h1>hi</h1>"),
    contentType: "text/html",
  },
  {
    path: "assets/app.js",
    data: text.encode("console.log(1)"),
    contentType: "text/javascript",
  },
  { path: "data.bin", data: new Uint8Array(MULTI_CHUNK_SIZE).fill(7) },
]

function setup(): { bee: MockBee; target: UploadTarget } {
  const bee = new MockBee(new MockChunkStore())
  return { bee, target: { mode: "stamper", bee, stamper: createMockStamper() } }
}

describe("uploadCollection", () => {
  it("lists back every file with its content type, and each reference downloads to its bytes", async () => {
    const { bee, target } = setup()
    const { reference } = await uploadCollection(target, FILES)

    const entries = await listCollection(bee, reference)
    expect(entries.map((e) => e.path).sort()).toEqual([
      "assets/app.js",
      "data.bin",
      "index.html",
    ])
    for (const file of FILES) {
      const entry = entries.find((e) => e.path === file.path)!
      expect(entry.contentType).toBe(
        file.contentType ?? "application/octet-stream",
      )
      expect(await downloadDataWithChunkAPI(bee, entry.reference)).toEqual(
        file.data,
      )
    }
  })

  it("encrypts content and manifest by default: every reference carries a key", async () => {
    const { bee, target } = setup()
    const { reference } = await uploadCollection(target, FILES)
    expect(reference).toHaveLength(ENCRYPTED_REF_HEX)
    for (const entry of await listCollection(bee, reference)) {
      expect(entry.reference).toHaveLength(ENCRYPTED_REF_HEX)
    }
  })

  it("encrypt: false leaves everything plain", async () => {
    const { bee, target } = setup()
    const { reference } = await uploadCollection(target, FILES, {
      encrypt: false,
    })
    expect(reference).toHaveLength(PLAIN_REF_HEX)
    for (const entry of await listCollection(bee, reference)) {
      expect(entry.reference).toHaveLength(PLAIN_REF_HEX)
    }
  })

  it("encryptManifest: false keeps the content encrypted behind a plain root", async () => {
    const { bee, target } = setup()
    const { reference } = await uploadCollection(target, FILES, {
      encryptManifest: false,
    })
    expect(reference).toHaveLength(PLAIN_REF_HEX)
    for (const entry of await listCollection(bee, reference)) {
      expect(entry.reference).toHaveLength(ENCRYPTED_REF_HEX)
    }
  })

  it("records the index and error documents the caller names, and keeps them out of the listing", async () => {
    const { bee, target } = setup()
    const { reference } = await uploadCollection(target, FILES, {
      indexDocument: "index.html",
      errorDocument: "404.html",
    })
    const manifest = await loadMantarayTreeWithChunkAPI(bee, reference)
    expect(new BeeMantarayNode(manifest).getDocsMetadata()).toEqual({
      indexDocument: "index.html",
      errorDocument: "404.html",
    })
    expect(
      (await listCollection(bee, reference)).map((e) => e.path),
    ).not.toContain("/")
  })

  it("reports progress once per file", async () => {
    const { target } = setup()
    const seen: Array<{ total: number; processed: number }> = []
    await uploadCollection(target, FILES, {
      onProgress: (progress) => seen.push({ ...progress }),
    })
    expect(seen).toEqual([
      { total: 3, processed: 1 },
      { total: 3, processed: 2 },
      { total: 3, processed: 3 },
    ])
  })
})

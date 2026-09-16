// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Two ways to end up with a manifest that will not load.
 *
 * The two save helpers hand their callback different things, and pairing one
 * with the other's uploader fails silently (#774): `saveMantarayTree` builds
 * the content-addressed chunk itself and records each node's address from
 * those bytes, so an uploader that treats its argument as a payload and wraps
 * it in a chunk of its own stores every node under an address the tree does
 * not know. Nothing throws; the root reference just points at nothing. Both
 * directions are pinned here — the public path round-trips with a
 * payload-wrapping uploader, the internal one does not — so a drift in either
 * contract shows up as a failing test rather than as an unreadable manifest.
 *
 * Uploads and downloads also come in pairs — `uploadData` with `downloadData`,
 * `uploadFile` with `downloadFile` — but both downloads take a plain string
 * reference, so crossing the pairs compiles and only breaks at runtime, inside
 * the Mantaray parser. The rest of these tests pin the readable error that
 * replaces that failure, and pin that every other failure is left alone.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { NULL_ADDRESS } from "@ethersphere/bee-js"
import { MantarayNode } from "@ethersphere/core-sdk"
import {
  saveMantarayTree,
  saveMantarayTreeRecursively,
  loadMantarayTreeWithChunkAPI,
} from "./mantaray"
import { uploadData, type UploadTarget } from "./upload"
import { hexToUint8Array } from "../utils/hex"
import {
  MockBee,
  MockChunkStore,
  createMockStamper,
} from "./feeds/epochs/test-utils"

const FILENAME = "index.bin"
const CONTENT_REFERENCE = "cd".repeat(32)

function setup(): { bee: MockBee; target: UploadTarget } {
  const bee = new MockBee(new MockChunkStore())
  return { bee, target: { mode: "stamper", bee, stamper: createMockStamper() } }
}

/** A two-fork manifest, the shape `uploadFile` builds. */
function makeManifest(): MantarayNode {
  const manifest = new MantarayNode()
  manifest.addFork(FILENAME, hexToUint8Array(CONTENT_REFERENCE), {
    "Content-Type": "application/octet-stream",
    Filename: FILENAME,
  })
  manifest.addFork("/", NULL_ADDRESS, { "website-index-document": FILENAME })
  return manifest
}

/** Upload plain bytes the way `uploadData` would, and return the reference. */
async function uploadPlainData(target: UploadTarget): Promise<string> {
  const data = new TextEncoder().encode("plain bytes, no manifest here")
  const { reference } = await uploadData(target, data)
  return reference
}

describe("saveMantarayTreeRecursively with a payload-wrapping uploader", () => {
  it("round-trips: the callback's returned reference is what the tree records", async () => {
    const { bee, target } = setup()

    const { rootReference } = await saveMantarayTreeRecursively(
      makeManifest(),
      async (data) => uploadData(target, data),
    )

    const loaded = await loadMantarayTreeWithChunkAPI(bee, rootReference)
    const fork = loaded.forks.get(FILENAME.charCodeAt(0))
    expect(fork).toBeDefined()
    expect(fork?.node.metadata?.Filename).toBe(FILENAME)
  })
})

describe("saveMantarayTree with a payload-wrapping uploader", () => {
  it("stores every node under an address the tree does not record (#774)", async () => {
    const { bee, target } = setup()

    // The callback wraps the finished chunk in a chunk of its own, the way
    // `SwarmIdClient.uploadChunk` does — and, as there, returns nothing the
    // tree would use to correct itself.
    const { rootReference } = await saveMantarayTree(
      makeManifest(),
      async (chunkData) => {
        await uploadData(target, chunkData)
        return {}
      },
    )

    await expect(
      loadMantarayTreeWithChunkAPI(bee, rootReference),
    ).rejects.toThrow()
  })
})

describe("loadMantarayTreeWithChunkAPI", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("names the matching download when the reference has no manifest", async () => {
    const { bee, target } = setup()
    const reference = await uploadPlainData(target)

    const error = await loadMantarayTreeWithChunkAPI(bee, reference).then(
      () => undefined,
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain("No manifest")
    expect(message).toContain("uploadData")
    expect(message).toContain("downloadData")
    expect(message).not.toContain("MantarayNode#unmarshal")
  })

  it("leaves a chunk fetch failure untouched", async () => {
    const { bee, target } = setup()
    const reference = await uploadPlainData(target)

    const networkError = new Error("fetch failed: ECONNREFUSED 127.0.0.1:1633")
    vi.spyOn(bee, "downloadChunk").mockRejectedValue(networkError)
    vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(loadMantarayTreeWithChunkAPI(bee, reference)).rejects.toBe(
      networkError,
    )
  })
})

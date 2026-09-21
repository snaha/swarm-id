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
 * the Mantaray parser — which rejects plain bytes two different ways depending
 * on how many of them there are. The rest of these tests pin the readable
 * error that replaces both failures, and pin that every other failure is left
 * alone.
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

/** The smallest payload a node header can occupy; below it the parser bails early. */
const MANTARAY_HEADER_SIZE = 64

/** Upload plain bytes the way `uploadData` would, and return the reference. */
async function uploadPlainData(
  target: UploadTarget,
  byteLength: number,
): Promise<string> {
  const data = new Uint8Array(byteLength).fill("x".charCodeAt(0))
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

  // Short of a header the parser reports "data too short"; past it, the header
  // it does read is not Mantaray's and it reports "invalid version hash". Both
  // mean the same thing to the caller.
  it.each([
    ["shorter than a node header", MANTARAY_HEADER_SIZE - 1],
    ["long enough to hold one", MANTARAY_HEADER_SIZE * 2],
  ])(
    "names the matching download for plain bytes %s",
    async (_case, byteLength) => {
      const { bee, target } = setup()
      const reference = await uploadPlainData(target, byteLength)

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
      expect((error as Error).cause).toBeInstanceOf(Error)
    },
  )

  it("leaves a child that fails to parse to the parser's own error", async () => {
    const { bee, target } = setup()
    const plainReference = await uploadPlainData(
      target,
      MANTARAY_HEADER_SIZE * 2,
    )

    // A root that parses, over children that do not: a corrupt manifest, not
    // a crossed pair.
    const manifest = makeManifest()
    for (const fork of manifest.forks.values()) {
      fork.node.selfAddress = hexToUint8Array(plainReference)
    }
    const { reference } = await uploadData(target, await manifest.marshal())

    await expect(loadMantarayTreeWithChunkAPI(bee, reference)).rejects.toThrow(
      /invalid version hash$/,
    )
  })

  it("leaves a chunk fetch failure untouched", async () => {
    const { bee, target } = setup()
    const reference = await uploadPlainData(target, MANTARAY_HEADER_SIZE * 2)

    const networkError = new Error("fetch failed: ECONNREFUSED 127.0.0.1:1633")
    vi.spyOn(bee, "downloadChunk").mockRejectedValue(networkError)
    vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(loadMantarayTreeWithChunkAPI(bee, reference)).rejects.toBe(
      networkError,
    )
  })
})

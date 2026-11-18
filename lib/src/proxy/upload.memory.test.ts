// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An upload of any length holds no more than what is on its way to the node:
 * a block it has sent must be collectable while the upload is still running.
 * Proven by collection, so the blocks `rechunk` hands out are watched through
 * weak references and `globalThis.gc` (vitest runs with `--expose-gc`).
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import type * as Chunking from "./chunking"

const { watched } = vi.hoisted(() => ({
  watched: [] as WeakRef<Uint8Array>[],
}))

vi.mock("./chunking", async (importOriginal) => {
  const actual = await importOriginal<typeof Chunking>()
  async function* watchedRechunk(
    source: AsyncIterable<Uint8Array>,
    size: number,
  ): AsyncGenerator<Uint8Array<ArrayBuffer>> {
    for await (const block of actual.rechunk(source, size)) {
      watched.push(new WeakRef(block))
      yield block
    }
  }
  return { ...actual, rechunk: watchedRechunk }
})

import { uploadDataStream, type UploadTarget } from "./upload"
import { CHUNK_SIZE } from "./chunking"

const GATEWAY = "https://gateway.example"
const REFERENCE = "ab".repeat(32)
const BLOCKS = 100
/** The block a generator frame may still hold in a register, and one more. */
const BLOCKS_A_FRAME_MAY_HOLD = 2

const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.unstubAllGlobals()
  watched.length = 0
})

describe("uploadDataStream's memory", () => {
  it("lets go of every block it has sent while the source is still open", async () => {
    const collect = globalThis.gc
    expect(collect).toBeTypeOf("function")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ reference: REFERENCE }))),
    )
    const target: UploadTarget = { mode: "subsidised", gatewayUrl: GATEWAY }
    let reachedPause!: () => void
    const atPause = new Promise<void>((resolve) => (reachedPause = resolve))
    let resume!: () => void
    const paused = new Promise<void>((resolve) => (resume = resolve))
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < BLOCKS; i++) yield new Uint8Array(CHUNK_SIZE).fill(i)
      reachedPause()
      await paused
    }

    const upload = uploadDataStream(target, source())
    await atPause
    await nextMacrotask()
    collect!()
    await nextMacrotask()
    const alive = watched.filter((ref) => ref.deref() !== undefined).length
    resume()
    await upload

    expect(watched).toHaveLength(BLOCKS)
    expect(alive).toBeLessThanOrEqual(BLOCKS_A_FRAME_MAY_HOLD)
  })
})

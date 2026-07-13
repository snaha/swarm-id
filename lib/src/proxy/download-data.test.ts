// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Console hygiene for the download path.
 *
 * For an encrypted reference the trailing 32 bytes ARE the decryption key,
 * and console output is routinely captured by extensions and error
 * reporters. These tests upload encrypted data, download it, and assert the
 * key half never reaches any console method — on success or on chunk-fetch
 * failure.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
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
const ADDRESS_HEX_LEN = 64

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

function spyOnConsole() {
  return [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "debug").mockImplementation(() => {}),
  ]
}

/** Everything the spied console methods received, flattened to one string. */
function consoleOutput(spies: ReturnType<typeof spyOnConsole>): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .flat()
    .map((arg) => {
      if (typeof arg === "string") return arg
      if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ""}`
      return JSON.stringify(arg) ?? String(arg)
    })
    .join("\n")
    .toLowerCase()
}

async function uploadEncrypted(
  target: UploadTarget,
  data: Uint8Array,
): Promise<{ reference: string; decryptionKeyHex: string }> {
  const { reference } = await uploadData(target, data, {
    encryptionKey: true,
  })
  expect(reference.length).toBe(ENCRYPTED_REF_HEX_LEN)
  return {
    reference,
    decryptionKeyHex: reference.slice(ADDRESS_HEX_LEN).toLowerCase(),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("downloadDataWithChunkAPI console hygiene", () => {
  it("never logs the decryption key of an encrypted reference", async () => {
    const { bee, target } = setup()
    const data = makeData(2 * CHUNK_SIZE) // root is an intermediate chunk

    const { reference, decryptionKeyHex } = await uploadEncrypted(target, data)

    const spies = spyOnConsole()
    const downloaded = await downloadDataWithChunkAPI(bee, reference)

    expect(downloaded).toEqual(data)
    expect(consoleOutput(spies)).not.toContain(decryptionKeyHex)
  })

  it("never logs the decryption key when the chunk fetch fails", async () => {
    const { bee, target } = setup()
    const data = makeData(CHUNK_SIZE)

    const { reference, decryptionKeyHex } = await uploadEncrypted(target, data)

    vi.spyOn(bee, "downloadChunk").mockRejectedValue(new Error("fetch failed"))

    const spies = spyOnConsole()
    await expect(downloadDataWithChunkAPI(bee, reference)).rejects.toThrow(
      "fetch failed",
    )

    expect(consoleOutput(spies)).not.toContain(decryptionKeyHex)
  })
})

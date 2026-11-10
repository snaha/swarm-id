// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { Stamper } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { makeContentAddressedChunk } from "../chunk"
import { isNotFoundError } from "../utils/bee-error"
import { createWeeb3Bee, type Weeb3Node } from "./weeb3-bee"

const STAMP_LENGTH = 113
const DEPTH = 17
const stamper = Stamper.fromBlank("11".repeat(32), "aa".repeat(32), DEPTH)

function fakeNode(result = "Upload result: success") {
  const store = new Map<string, Uint8Array>()
  const node: Weeb3Node = {
    async postPushChunk(data, _soc, address, stamp) {
      expect(stamp.length).toBe(STAMP_LENGTH)
      store.set(Binary.uint8ArrayToHex(address), data)
      return result
    },
    async retrieveChunk(address) {
      return store.get(address) ?? new Uint8Array()
    },
    async connectionCount() {
      return 1
    },
  }
  return { node, store }
}

describe("createWeeb3Bee", () => {
  it("pushes a stamped chunk and reads it back", async () => {
    const { node } = fakeNode()
    const bee = createWeeb3Bee(Promise.resolve(node))
    const chunk = makeContentAddressedChunk(new TextEncoder().encode("hi"))

    const { reference } = await bee.chunk.upload(
      stamper.stamp(chunk.address.toUint8Array()),
      chunk.data,
    )

    expect(reference.toHex()).toBe(chunk.address.toHex())
    expect(await bee.chunk.download(reference.toHex())).toEqual(chunk.data)
    expect(await bee.connectivity.isConnected()).toBe(true)
  })

  it("throws when weeb-3 reports the push failed", async () => {
    const bee = createWeeb3Bee(
      Promise.resolve(fakeNode("Upload result: failure").node),
    )
    const chunk = makeContentAddressedChunk(new Uint8Array([1]))
    await expect(
      bee.chunk.upload(stamper.stamp(chunk.address.toUint8Array()), chunk.data),
    ).rejects.toThrow(/push failed/)
  })

  it("reads a miss as a 404", async () => {
    const bee = createWeeb3Bee(Promise.resolve(fakeNode().node))
    const error = await bee.chunk.download("bb".repeat(32)).catch((e) => e)
    expect(isNotFoundError(error)).toBe(true)
  })

  it("refuses a SOC, which weeb-3 returns without its signature", async () => {
    const { node, store } = fakeNode()
    const bee = createWeeb3Bee(Promise.resolve(node))
    store.set(
      "cc".repeat(32),
      makeContentAddressedChunk(new Uint8Array([1])).data,
    )
    await expect(bee.chunk.download("cc".repeat(32))).rejects.toThrow(/SOC/)
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The epoch-feed SOC address. A reader that derives a different address than
 * the writer stamped never finds the entry, so it is pinned to bytes.
 */

import { describe, it, expect } from "vitest"
import { Topic } from "@ethersphere/bee-js"
import { EpochIndex } from "./epoch"
import { epochSocAddress } from "./updater"
import { createTestSigner } from "./test-utils"

const TOPIC = Topic.fromString("epoch-vector")
const OWNER = createTestSigner().publicKey().address()
const EPOCH_START = 1024n
const EPOCH_LEVEL = 10
const ROOT_LEVEL = 32

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")

describe("epochSocAddress", () => {
  it("derives the root epoch's address", async () => {
    const address = await epochSocAddress(
      TOPIC,
      new EpochIndex(0n, ROOT_LEVEL),
      OWNER,
    )
    expect(hex(address)).toBe(
      "8215ab1230bc0868373e67c3a63beeaf02d0b0c52bfebf291e009ded76603070",
    )
  })

  it("derives a child epoch's address", async () => {
    const address = await epochSocAddress(
      TOPIC,
      new EpochIndex(EPOCH_START, EPOCH_LEVEL),
      OWNER,
    )
    expect(hex(address)).toBe(
      "c3c81cfdac859b439831fbca1784b7a5b886677dc95ded6b14bf722fd3de9cff",
    )
  })
})

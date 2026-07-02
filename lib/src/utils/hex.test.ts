// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { hexToUint8Array, uint8ArrayToHex } from "./hex"

describe("uint8ArrayToHex", () => {
  it("encodes bytes as zero-padded lowercase hex", () => {
    expect(uint8ArrayToHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe(
      "00010f10ff",
    )
  })

  it("encodes empty input as an empty string", () => {
    expect(uint8ArrayToHex(new Uint8Array())).toBe("")
  })
})

describe("hexToUint8Array", () => {
  it("decodes with or without a 0x prefix", () => {
    expect([...hexToUint8Array("00010f10ff")]).toEqual([0, 1, 15, 16, 255])
    expect([...hexToUint8Array("0x00010f10ff")]).toEqual([0, 1, 15, 16, 255])
  })

  it("round-trips with uint8ArrayToHex", () => {
    const bytes = new Uint8Array([1, 2, 3, 250])
    expect([...hexToUint8Array(uint8ArrayToHex(bytes))]).toEqual([...bytes])
  })

  it("throws on an odd-length string", () => {
    expect(() => hexToUint8Array("abc")).toThrow("Invalid hex string.")
  })

  it("throws on non-hex characters instead of decoding them to zero", () => {
    expect(() => hexToUint8Array("zz")).toThrow("Invalid hex string.")
  })
})

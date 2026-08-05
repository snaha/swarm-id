// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest"
import { decodeInstruction } from "./local-solver"

const RECIPIENT = "0x1111111111111111111111111111111111111111"

/** The app's `encodeInstruction`, as a deposit carries it. */
function encode(recipient: string, xdaiWei: bigint): string {
  return `0x${recipient.replace(/^0x/, "")}${xdaiWei.toString(16).padStart(64, "0")}`
}

describe("decodeInstruction", () => {
  it("reads back what the app encodes", () => {
    const xdaiWei = 60000000000000000n
    expect(decodeInstruction(encode(RECIPIENT, xdaiWei))).toEqual({
      recipient: RECIPIENT,
      xdaiWei,
    })
  })

  it("handles an amount that needs the full 32 bytes", () => {
    const xdaiWei = 2n ** 255n
    expect(decodeInstruction(encode(RECIPIENT, xdaiWei))?.xdaiWei).toBe(xdaiWei)
  })

  // A plain transfer to the solver address is somebody else's business; paying
  // out against one would invent a delivery nobody asked for.
  it("ignores a deposit with no calldata", () => {
    expect(decodeInstruction("0x")).toBeUndefined()
    expect(decodeInstruction(undefined)).toBeUndefined()
  })

  it("ignores calldata of the wrong length", () => {
    expect(decodeInstruction(`0x${"ab".repeat(51)}`)).toBeUndefined()
    expect(decodeInstruction(`0x${"ab".repeat(53)}`)).toBeUndefined()
  })

  // Zero would mean "deliver nothing" — a no-op fill that still costs a
  // transaction and reads as a successful payment.
  it("ignores a zero amount", () => {
    expect(decodeInstruction(encode(RECIPIENT, 0n))).toBeUndefined()
  })
})

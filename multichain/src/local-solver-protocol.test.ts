// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest"
import {
  type DeliveryInstruction,
  decodeDeliveryInstruction,
  encodeDeliveryInstruction,
} from "./local-solver-protocol"

const RECIPIENT = "0x1111111111111111111111111111111111111111"

describe("delivery instruction round trip", () => {
  // Both ends of the wire, against each other. Restating the encoder in the
  // test would only prove the decoder matches the restatement — which is what
  // this replaced, and it would not have caught the two sides drifting.
  it.each([
    ["a typical extend", 60000000000000000n],
    ["a single wei", 1n],
    ["the full 32 bytes", 2n ** 255n],
  ])("survives %s", (_label, xdaiWei) => {
    const encoded = encodeDeliveryInstruction({ recipient: RECIPIENT, xdaiWei })
    expect(decodeDeliveryInstruction(encoded)).toEqual({
      recipient: RECIPIENT,
      xdaiWei,
    })
  })

  it("produces the fixed 52-byte layout whatever the amount", () => {
    const small = encodeDeliveryInstruction({
      recipient: RECIPIENT,
      xdaiWei: 1n,
    })
    const large = encodeDeliveryInstruction({
      recipient: RECIPIENT,
      xdaiWei: 2n ** 255n,
    })
    const HEX_CHARS = 2 + 40 + 64
    expect(small).toHaveLength(HEX_CHARS)
    expect(large).toHaveLength(HEX_CHARS)
  })

  it("normalises a checksummed recipient, since `to` arrives lower-cased", () => {
    const checksummed = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720" as const
    expect(
      decodeDeliveryInstruction(
        encodeDeliveryInstruction({ recipient: checksummed, xdaiWei: 1n }),
      )?.recipient,
    ).toBe(checksummed.toLowerCase())
  })

  it("survives with a token pull attached", () => {
    const instruction: DeliveryInstruction = {
      recipient: RECIPIENT,
      xdaiWei: 60000000000000000n,
      pull: {
        token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as const,
        amountWei: 60852n,
      },
    }
    expect(
      decodeDeliveryInstruction(encodeDeliveryInstruction(instruction)),
    ).toEqual(instruction)
  })

  it("keeps the pull-free layout unchanged, so old deposits still decode", () => {
    // The native form is the wire format deposits already on a chain carry;
    // growing it in place would strand them behind a length check.
    expect(
      encodeDeliveryInstruction({ recipient: RECIPIENT, xdaiWei: 1n }),
    ).toHaveLength(2 + 40 + 64)
  })
})

describe("decodeDeliveryInstruction rejects", () => {
  // A plain transfer to the solver address is somebody else's business; paying
  // out against one would invent a delivery nobody asked for.
  it("a deposit with no calldata", () => {
    expect(decodeDeliveryInstruction("0x")).toBeUndefined()
    expect(decodeDeliveryInstruction(undefined)).toBeUndefined()
  })

  it("calldata of the wrong length", () => {
    expect(decodeDeliveryInstruction(`0x${"ab".repeat(51)}`)).toBeUndefined()
    expect(decodeDeliveryInstruction(`0x${"ab".repeat(53)}`)).toBeUndefined()
  })

  // Zero would be a no-op fill that still costs a transaction and still reads
  // as a settled payment.
  it("a zero amount", () => {
    expect(
      decodeDeliveryInstruction(
        encodeDeliveryInstruction({ recipient: RECIPIENT, xdaiWei: 0n }),
      ),
    ).toBeUndefined()
  })

  it("a zero token pull", () => {
    expect(
      decodeDeliveryInstruction(
        encodeDeliveryInstruction({
          recipient: RECIPIENT,
          xdaiWei: 1n,
          pull: {
            token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            amountWei: 0n,
          },
        }),
      ),
    ).toBeUndefined()
  })
})

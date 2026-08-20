// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { type AbiFunction, toFunctionSelector } from "viem"
import { ERC20_ABI, POSTAGE_STAMP_ABI } from "./abi"
import { type BundledCall, resizeCalls } from "./postage-bundle"
import { gnosisMainnetSettings } from "./settings"

function selectorOf(abi: readonly unknown[], name: string): string {
  const fn = (abi as AbiFunction[]).find(
    (entry) => entry.type === "function" && entry.name === name,
  )
  if (!fn) {
    throw new Error(`No such function in ABI: ${name}`)
  }
  return toFunctionSelector(fn)
}

/** What a bundled call is, read back off the wire: who it calls, and which function. */
function calledFunction(call: BundledCall): {
  target: string
  selector: string
} {
  return { target: call.target.toLowerCase(), selector: call.data.slice(0, 10) }
}

const SETTINGS = gnosisMainnetSettings()
const BATCH_ID =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const
const OWNER_KEY =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as const

const APPROVE = selectorOf(ERC20_ABI, "approve")
const TOP_UP = selectorOf(POSTAGE_STAMP_ABI, "topUp")
const INCREASE_DEPTH = selectorOf(POSTAGE_STAMP_ABI, "increaseDepth")

/**
 * The resize call ORDER is load-bearing and nothing else pins it.
 *
 * `increaseDepth` checks the post-dilution per-chunk balance against the
 * contract's minimum BEFORE any compensation, so a bundle that dilutes before
 * topping up reverts — atomicity does not rescue it. The fork suite exercises
 * the order on chain, but only against fixtures far above that floor: there a
 * flipped order would still revert, though on the exact-allowance design rather
 * than on the floor the comments cite, so it proves the wrong thing. Here the
 * order is checked for what it is — a property of the three calls, decided
 * before any chain sees them.
 */
describe("resizeCalls", () => {
  it("approves the PostageStamp, then tops up, then increases the depth", () => {
    const calls = resizeCalls(
      {
        originPrivateKey: OWNER_KEY,
        batchId: BATCH_ID,
        amountPerChunk: 24_000n,
        totalPlur: 24_000n << 17n,
        newDepth: 18,
      },
      SETTINGS,
    )

    expect(calls.map(calledFunction)).toEqual([
      // The allowance goes to the PostageStamp — the contract that pulls the
      // BZZ — not to the batch or the owner.
      {
        target: SETTINGS.addresses.bzz.toLowerCase(),
        selector: APPROVE,
      },
      {
        target: SETTINGS.addresses.postageStamp.toLowerCase(),
        selector: TOP_UP,
      },
      {
        target: SETTINGS.addresses.postageStamp.toLowerCase(),
        selector: INCREASE_DEPTH,
      },
    ])
    // The spender inside that approve, as the last 20 bytes of its first word.
    const [approve] = calls
    expect(approve.data.slice(10 + 24, 10 + 64).toLowerCase()).toBe(
      SETTINGS.addresses.postageStamp.slice(2).toLowerCase(),
    )
  })

  it("sends increaseDepth alone when there is no lifespan to keep", () => {
    const calls = resizeCalls(
      {
        originPrivateKey: OWNER_KEY,
        batchId: BATCH_ID,
        amountPerChunk: 0n,
        totalPlur: 0n,
        newDepth: 18,
      },
      SETTINGS,
    )

    // Not "approve and top up zero": an allowance of nothing and a top-up of
    // nothing are two calls that do nothing, paid for in gas.
    expect(calls.map(calledFunction)).toEqual([
      {
        target: SETTINGS.addresses.postageStamp.toLowerCase(),
        selector: INCREASE_DEPTH,
      },
    ])
  })
})

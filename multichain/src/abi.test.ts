// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { toFunctionSelector, type AbiFunction } from "viem"
import { ACCOUNT_7702_ABI, ERC20_ABI, POSTAGE_STAMP_ABI } from "./abi"
import { SIMPLE_7702_ACCOUNT_RUNTIME_BYTECODE } from "./delegate-bytecode"

function selectorOf(abi: readonly unknown[], name: string): string {
  const fn = (abi as AbiFunction[]).find(
    (entry) => entry.type === "function" && entry.name === name,
  )
  if (!fn) {
    throw new Error(`No such function in ABI: ${name}`)
  }
  return toFunctionSelector(fn)
}

/**
 * Pin the write selectors to constants verified against the deployed
 * contract's source (gnosis.blockscout.com, Sourcify) and the raw-selector
 * read path in lib/src/utils/postage-contract.ts — so an ABI typo here can
 * never produce calldata that reaches a wallet.
 */
describe("PostageStamp ABI selectors", () => {
  it("matches the verified write selectors", () => {
    expect(selectorOf(POSTAGE_STAMP_ABI, "topUp")).toBe("0xb67644b9")
    expect(selectorOf(POSTAGE_STAMP_ABI, "increaseDepth")).toBe("0x47aab79b")
    expect(selectorOf(POSTAGE_STAMP_ABI, "createBatch")).toBe("0x5239af71")
  })

  it("matches the read selectors the lib already uses", () => {
    expect(selectorOf(POSTAGE_STAMP_ABI, "batches")).toBe("0xc81e25ab")
    expect(selectorOf(POSTAGE_STAMP_ABI, "lastPrice")).toBe("0x053f14da")
    expect(selectorOf(POSTAGE_STAMP_ABI, "currentTotalOutPayment")).toBe(
      "0x51b17cd0",
    )
    expect(selectorOf(POSTAGE_STAMP_ABI, "minimumInitialBalancePerChunk")).toBe(
      "0x90697842",
    )
    expect(selectorOf(POSTAGE_STAMP_ABI, "paused")).toBe("0x5c975abb")
  })

  it("matches the canonical ERC-20 selectors", () => {
    expect(selectorOf(ERC20_ABI, "approve")).toBe("0x095ea7b3")
    expect(selectorOf(ERC20_ABI, "transfer")).toBe("0xa9059cbb")
    expect(selectorOf(ERC20_ABI, "balanceOf")).toBe("0x70a08231")
    expect(selectorOf(ERC20_ABI, "allowance")).toBe("0xdd62ed3e")
  })

  /**
   * The delegate is the one contract here we did not write, and a wrong
   * selector against it fails SILENTLY — an unknown selector on a 7702 account
   * hits the fallback, the batch never runs, and the transaction still
   * succeeds. So pin it against the deployed dispatch table itself.
   */
  it("matches the delegate's executeBatch, as found in its deployed bytecode", () => {
    const selector = selectorOf(ACCOUNT_7702_ABI, "executeBatch")
    expect(selector).toBe("0x34fcd5be")
    expect(SIMPLE_7702_ACCOUNT_RUNTIME_BYTECODE).toContain(selector.slice(2))
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { decodeFunctionData, parseAbi } from "viem"
import { gnosisMainnetSettings } from "./settings"
import { buildExactInputSwapData } from "./sushi"

const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
])

describe("buildExactInputSwapData", () => {
  it("encodes a WXDAI→BZZ exactInputSingle with the given bounds", () => {
    const settings = gnosisMainnetSettings()
    const recipient =
      "0x26234a2ad3ba8b398a762f279b792cfacd536a3f" as `0x${string}`
    const data = buildExactInputSwapData(
      1_000_000_000_000_000_000n,
      42n,
      recipient,
      1_800_000_000n,
      settings,
    )
    const decoded = decodeFunctionData({ abi: ROUTER_ABI, data })
    expect(decoded.functionName).toBe("exactInputSingle")
    const params = decoded.args[0]
    expect(params.tokenIn.toLowerCase()).toBe(
      settings.addresses.wxdai?.toLowerCase(),
    )
    expect(params.tokenOut.toLowerCase()).toBe(settings.addresses.bzz)
    expect(params.fee).toBe(settings.sushiV3BzzPoolFee)
    expect(params.recipient.toLowerCase()).toBe(recipient)
    expect(params.amountIn).toBe(1_000_000_000_000_000_000n)
    expect(params.amountOutMinimum).toBe(42n)
    expect(params.deadline).toBe(1_800_000_000n)
  })
})

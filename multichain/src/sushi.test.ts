// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { decodeFunctionData, parseAbi } from "viem"
import { gnosisMainnetSettings } from "./settings"
import {
  buildExactInputSwapData,
  buildRoutedSwapData,
  buildSwapData,
} from "./sushi"

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

const ROUTED_ABI = parseAbi([
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
])

/** The packed path, split back into its tokens and fees. */
function decodePath(path: string) {
  const body = path.slice(2)
  const tokens: string[] = []
  const fees: number[] = []
  for (let at = 0; at < body.length; at += 46) {
    tokens.push(`0x${body.slice(at, at + 40)}`)
    if (at + 46 <= body.length) {
      fees.push(Number.parseInt(body.slice(at + 40, at + 46), 16))
    }
  }
  return { tokens, fees }
}

describe("buildRoutedSwapData", () => {
  const settings = gnosisMainnetSettings()
  const recipient =
    "0x26234a2ad3ba8b398a762f279b792cfacd536a3f" as `0x${string}`

  /**
   * An exact-INPUT path runs from what is spent to what is wanted. Reversed it
   * still decodes and still quotes — it just prices the opposite trade.
   */
  it("encodes the WXDAI→USDC→BZZ path in spend-first order", () => {
    const data = buildRoutedSwapData(
      1n,
      2n,
      recipient,
      1_800_000_000n,
      settings,
    )
    const decoded = decodeFunctionData({ abi: ROUTED_ABI, data })
    expect(decoded.functionName).toBe("exactInput")
    const { tokens, fees } = decodePath(decoded.args[0].path)
    expect(tokens).toEqual([
      settings.addresses.wxdai.toLowerCase(),
      settings.addresses.usdc.toLowerCase(),
      settings.addresses.bzz.toLowerCase(),
    ])
    expect(fees).toEqual([
      settings.sushiV3WxdaiUsdcPoolFee,
      settings.sushiV3UsdcBzzPoolFee,
    ])
  })

  it("carries the bounds and recipient through unchanged", () => {
    const data = buildRoutedSwapData(
      1_000_000_000_000_000_000n,
      42n,
      recipient,
      1_800_000_000n,
      settings,
    )
    const params = decodeFunctionData({ abi: ROUTED_ABI, data }).args[0]
    expect(params.recipient.toLowerCase()).toBe(recipient)
    expect(params.amountIn).toBe(1_000_000_000_000_000_000n)
    expect(params.amountOutMinimum).toBe(42n)
    expect(params.deadline).toBe(1_800_000_000n)
  })
})

describe("buildSwapData", () => {
  const settings = gnosisMainnetSettings()
  const recipient =
    "0x26234a2ad3ba8b398a762f279b792cfacd536a3f" as `0x${string}`

  /**
   * The route a quote was taken on must be the route executed: the two pools
   * can differ by far more than the 0.5% slippage bound, so a mismatch spends
   * the whole budget on the spread and reverts — or fills badly.
   */
  it("dispatches to the encoding the quoted route names", () => {
    const args = [1n, 2n, recipient, 1_800_000_000n, settings] as const
    expect(buildSwapData("direct", ...args)).toBe(
      buildExactInputSwapData(...args),
    )
    expect(buildSwapData("viaUsdc", ...args)).toBe(buildRoutedSwapData(...args))
  })
})

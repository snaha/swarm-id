// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { RollingValueProvider } from "cafe-utility"
import { encodeFunctionData, parseAbi } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { publicClientFor, walletClientFor } from "./chain"
import { getGasPrice, getTransactionCount } from "./rpc"
import type { MultichainSettings } from "./settings"
import { withFeeTooLowRetry } from "./write-retry"

const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
])

const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
])

// 0.5% slippage tolerance on the quoted output, as upstream.
const SLIPPAGE_NUMERATOR = 995n
const SLIPPAGE_DENOMINATOR = 1000n
const DEADLINE_SECONDS = 600
const MILLIS_PER_SECOND = 1000
// The router refunds unused gas; estimate + 25% headroom, as upstream.
const GAS_BUFFER_NUMERATOR = 5n
const GAS_BUFFER_DENOMINATOR = 4n

interface SushiAddresses {
  wxdai: `0x${string}`
  router: `0x${string}`
  quoter: `0x${string}`
}

/**
 * The bee-compose anvil chain deploys no DEX, so swaps only exist on
 * mainnet-like chains. Callers on the local chain mock the swap leg (transfer
 * BZZ from the dev funder instead) — see dev.ts.
 */
function requireSushi(settings: MultichainSettings): SushiAddresses {
  const { wxdai, sushiV3Router, sushiV3Quoter } = settings.addresses
  if (!wxdai || !sushiV3Router || !sushiV3Quoter) {
    throw new Error(
      "SushiSwap is not configured for this chain (no DEX on the local dev chain — mock the swap leg instead).",
    )
  }
  return { wxdai, router: sushiV3Router, quoter: sushiV3Quoter }
}

/** Quoted xDAI cost (in wei) of acquiring `bzzOut` PLUR of BZZ. */
export async function quoteXdaiInForBzzOut(
  bzzOut: bigint,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<bigint> {
  const sushi = requireSushi(settings)
  const client = publicClientFor(settings, rpcProvider)
  const { result } = await client.simulateContract({
    address: sushi.quoter,
    abi: QUOTER_ABI,
    functionName: "quoteExactOutputSingle",
    args: [
      {
        tokenIn: sushi.wxdai,
        tokenOut: settings.addresses.bzz,
        amount: bzzOut,
        fee: settings.sushiV3BzzPoolFee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
  return result[0]
}

/** Quoted BZZ output (in PLUR) for spending `xdaiIn` wei of xDAI. */
export async function quoteBzzOutForXdaiIn(
  xdaiIn: bigint,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<bigint> {
  const sushi = requireSushi(settings)
  const client = publicClientFor(settings, rpcProvider)
  const { result } = await client.simulateContract({
    address: sushi.quoter,
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: sushi.wxdai,
        tokenOut: settings.addresses.bzz,
        amountIn: xdaiIn,
        fee: settings.sushiV3BzzPoolFee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
  return result[0]
}

/**
 * Router calldata for an exact-input xDAI→BZZ swap. Pure encoding (exported
 * for unit testing); the native value carried with the transaction is the
 * xDAI input, which the router wraps to WXDAI itself.
 */
export function buildExactInputSwapData(
  amountIn: bigint,
  amountOutMinimum: bigint,
  recipient: `0x${string}`,
  deadline: bigint,
  settings: MultichainSettings,
): `0x${string}` {
  const sushi = requireSushi(settings)
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: sushi.wxdai,
        tokenOut: settings.addresses.bzz,
        fee: settings.sushiV3BzzPoolFee,
        recipient,
        deadline,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
}

export interface SwapXdaiToBzzOptions {
  originPrivateKey: `0x${string}`
  /** xDAI to spend, in wei. */
  amountXdai: bigint
  /** BZZ recipient — for postage flows, the batch-owner address itself. */
  recipient: `0x${string}`
  nonce?: number
}

/**
 * Swap native xDAI for BZZ on SushiSwap V3. Quotes first and applies 0.5%
 * slippage tolerance; reverts (deadline 10min) rather than filling badly.
 */
export async function swapXdaiToBzz(
  options: SwapXdaiToBzzOptions,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<`0x${string}`> {
  const sushi = requireSushi(settings)
  const account = privateKeyToAccount(options.originPrivateKey)
  const expectedOut = await quoteBzzOutForXdaiIn(
    options.amountXdai,
    settings,
    rpcProvider,
  )
  const amountOutMinimum =
    (expectedOut * SLIPPAGE_NUMERATOR) / SLIPPAGE_DENOMINATOR
  const deadline = BigInt(
    Math.floor(Date.now() / MILLIS_PER_SECOND) + DEADLINE_SECONDS,
  )
  const data = buildExactInputSwapData(
    options.amountXdai,
    amountOutMinimum,
    options.recipient,
    deadline,
    settings,
  )

  const publicClient = publicClientFor(settings, rpcProvider)
  const gasEstimate = await publicClient.estimateGas({
    account: account.address,
    to: sushi.router,
    value: options.amountXdai,
    data,
  })

  const client = walletClientFor(settings, rpcProvider)
  return withFeeTooLowRetry(async () => {
    const serializedTransaction = await account.signTransaction({
      chainId: settings.chainId,
      gas: (gasEstimate * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR,
      gasPrice: await getGasPrice(settings, rpcProvider),
      type: "legacy",
      to: sushi.router,
      value: options.amountXdai,
      data,
      nonce:
        options.nonce ??
        (await getTransactionCount(account.address, settings, rpcProvider)),
    })
    return client.sendRawTransaction({ serializedTransaction })
  })
}

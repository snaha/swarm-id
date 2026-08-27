// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { RollingValueProvider } from "cafe-utility"
import { encodeFunctionData, encodePacked, parseAbi } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { publicClientFor, walletClientFor } from "./chain"
import { getGasPrice, getTransactionCount } from "./rpc"
import type { MultichainSettings } from "./settings"
import { withFeeTooLowRetry } from "./write-retry"

const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
  "function quoteExactOutput(bytes path, uint256 amountOut) returns (uint256 amountIn, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
])

const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
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

/** The pool's three addresses, under the names the swap helpers use. */
function requireSushi(settings: MultichainSettings): SushiAddresses {
  const { wxdai, sushiV3Router, sushiV3Quoter } = settings.addresses
  return { wxdai, router: sushiV3Router, quoter: sushiV3Quoter }
}

/**
 * How a swap reaches BZZ.
 *
 * `direct` is a single pool against BZZ; `viaUsdc` hops through USDC. Which are
 * available depends on what is being spent — WXDAI has both, USDC only the
 * direct one (it IS the hop), and BZZ needs no swap at all.
 */
export type SwapRoute = "direct" | "viaUsdc"

/**
 * What a payment can be made in, on the Gnosis side.
 *
 * `xdai` and `wxdai` are the same asset and the same pool; they differ only in
 * how they are spent — native value the router wraps itself, against an ERC20
 * transfer needing an approval. `bzz` is already what the operation wants, so
 * it never reaches a pool at all.
 */
export type SwapInput = "xdai" | "wxdai" | "usdc" | "bzz"

/** The inputs that have to be swapped to become BZZ. */
export type SwappableInput = Exclude<SwapInput, "bzz">

/** The inputs spent as an ERC20 — an approval first, and no native value. */
export type TokenInput = Exclude<SwapInput, "xdai" | "bzz">

/** A priced route: the figure, and which way round it was reached. */
export interface RoutedQuote {
  amount: bigint
  route: SwapRoute
}

/**
 * The multi-hop path, as the router and quoter encode it: token, fee, token,
 * fee, token — packed, no padding.
 *
 * Exact-INPUT paths run from the token being spent to the token wanted;
 * exact-OUTPUT paths run backwards, from what is wanted to what is spent.
 * Getting that round the wrong way does not fail loudly — it prices a
 * different trade.
 */
function usdcPath(
  settings: MultichainSettings,
  direction: "input" | "output",
): `0x${string}` {
  const { wxdai, usdc, bzz } = settings.addresses
  const types = ["address", "uint24", "address", "uint24", "address"] as const
  return direction === "input"
    ? encodePacked(types, [
        wxdai,
        settings.sushiV3WxdaiUsdcPoolFee,
        usdc,
        settings.sushiV3UsdcBzzPoolFee,
        bzz,
      ])
    : encodePacked(types, [
        bzz,
        settings.sushiV3UsdcBzzPoolFee,
        usdc,
        settings.sushiV3WxdaiUsdcPoolFee,
        wxdai,
      ])
}

/**
 * The token address and pool fee a `direct` swap uses for a given input.
 *
 * xDAI is spent as WXDAI — the router wraps native value itself — so its direct
 * pool is BZZ/WXDAI. USDC's is BZZ/USDC, which is the deeper of the two and the
 * reason a WXDAI swap is usually worth routing through USDC at all.
 */
function directPool(
  input: SwappableInput,
  settings: MultichainSettings,
): { tokenIn: `0x${string}`; fee: number } {
  return input === "usdc"
    ? { tokenIn: settings.addresses.usdc, fee: settings.sushiV3UsdcBzzPoolFee }
    : { tokenIn: settings.addresses.wxdai, fee: settings.sushiV3BzzPoolFee }
}

/**
 * Whether a routed alternative exists for this input. Only xDAI has one: a USDC
 * swap already ends at the deep pool, and routing it through itself is not a
 * route.
 */
function hasRoutedAlternative(input: SwappableInput): boolean {
  return input !== "usdc"
}

/**
 * Price both routes and keep the better, by `prefer`.
 *
 * A route that reverts is not a failure: a pool can be missing, or too thin to
 * fill this size. It drops out and the other one answers. Only both failing is
 * an error, and then the direct route's own error is the one raised — it is
 * the route whose absence actually means the swap cannot happen.
 */
async function bestOf(
  quotes: [Promise<bigint>, Promise<bigint>],
  prefer: "lower" | "higher",
): Promise<RoutedQuote> {
  const [direct, viaUsdc] = await Promise.allSettled(quotes)
  if (direct.status === "rejected" && viaUsdc.status === "rejected") {
    throw direct.reason
  }
  if (direct.status === "rejected") {
    return {
      amount: (viaUsdc as PromiseFulfilledResult<bigint>).value,
      route: "viaUsdc",
    }
  }
  if (viaUsdc.status === "rejected") {
    return { amount: direct.value, route: "direct" }
  }
  const usdcWins =
    prefer === "lower"
      ? viaUsdc.value < direct.value
      : viaUsdc.value > direct.value
  return usdcWins
    ? { amount: viaUsdc.value, route: "viaUsdc" }
    : { amount: direct.value, route: "direct" }
}

/** Quoted cost (in `input`'s own units) of acquiring `bzzOut` PLUR of BZZ. */
export async function bestExactOutput(
  bzzOut: bigint,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
  input: SwappableInput = "xdai",
): Promise<RoutedQuote> {
  const sushi = requireSushi(settings)
  const client = publicClientFor(settings, rpcProvider)
  const pool = directPool(input, settings)
  const single = client
    .simulateContract({
      address: sushi.quoter,
      abi: QUOTER_ABI,
      functionName: "quoteExactOutputSingle",
      args: [
        {
          tokenIn: pool.tokenIn,
          tokenOut: settings.addresses.bzz,
          amount: bzzOut,
          fee: pool.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })
    .then(({ result }) => result[0])
  if (!hasRoutedAlternative(input)) {
    return { amount: await single, route: "direct" }
  }
  const routed = client
    .simulateContract({
      address: sushi.quoter,
      abi: QUOTER_ABI,
      functionName: "quoteExactOutput",
      args: [usdcPath(settings, "output"), bzzOut],
    })
    .then(({ result }) => result[0])
  return bestOf([single, routed], "lower")
}

/** Quoted BZZ output (in PLUR) for spending `amountIn` of `input`. */
export async function bestExactInput(
  amountIn: bigint,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
  input: SwappableInput = "xdai",
): Promise<RoutedQuote> {
  const sushi = requireSushi(settings)
  const client = publicClientFor(settings, rpcProvider)
  const pool = directPool(input, settings)
  const single = client
    .simulateContract({
      address: sushi.quoter,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: pool.tokenIn,
          tokenOut: settings.addresses.bzz,
          amountIn,
          fee: pool.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })
    .then(({ result }) => result[0])
  if (!hasRoutedAlternative(input)) {
    return { amount: await single, route: "direct" }
  }
  const routed = client
    .simulateContract({
      address: sushi.quoter,
      abi: QUOTER_ABI,
      functionName: "quoteExactInput",
      args: [usdcPath(settings, "input"), amountIn],
    })
    .then(({ result }) => result[0])
  return bestOf([single, routed], "higher")
}

/** Quoted xDAI cost (in wei) of acquiring `bzzOut` PLUR of BZZ. */
export async function quoteXdaiInForBzzOut(
  bzzOut: bigint,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<bigint> {
  return (await bestExactOutput(bzzOut, settings, rpcProvider)).amount
}

/** Quoted BZZ output (in PLUR) for spending `xdaiIn` wei of xDAI. */
export async function quoteBzzOutForXdaiIn(
  xdaiIn: bigint,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<bigint> {
  return (await bestExactInput(xdaiIn, settings, rpcProvider)).amount
}

/**
 * Router calldata for an exact-input xDAI→BZZ swap through the WXDAI/BZZ pool.
 * Pure encoding (exported for unit testing); the native value carried with the
 * transaction is the xDAI input, which the router wraps to WXDAI itself.
 */
export function buildExactInputSwapData(
  amountIn: bigint,
  amountOutMinimum: bigint,
  recipient: `0x${string}`,
  deadline: bigint,
  settings: MultichainSettings,
  input: SwappableInput = "xdai",
): `0x${string}` {
  const pool = directPool(input, settings)
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: pool.tokenIn,
        tokenOut: settings.addresses.bzz,
        fee: pool.fee,
        recipient,
        deadline,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
}

/**
 * The same swap, routed WXDAI→USDC→BZZ. Native value still works: the router
 * wraps `msg.value` whenever the path STARTS at WXDAI, exactly as the single-
 * hop call does.
 */
export function buildRoutedSwapData(
  amountIn: bigint,
  amountOutMinimum: bigint,
  recipient: `0x${string}`,
  deadline: bigint,
  settings: MultichainSettings,
): `0x${string}` {
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "exactInput",
    args: [
      {
        path: usdcPath(settings, "input"),
        recipient,
        deadline,
        amountIn,
        amountOutMinimum,
      },
    ],
  })
}

/** Calldata for whichever route `bestExactInput` picked. */
export function buildSwapData(
  route: SwapRoute,
  amountIn: bigint,
  amountOutMinimum: bigint,
  recipient: `0x${string}`,
  deadline: bigint,
  settings: MultichainSettings,
  input: SwappableInput = "xdai",
): `0x${string}` {
  return route === "viaUsdc"
    ? buildRoutedSwapData(
        amountIn,
        amountOutMinimum,
        recipient,
        deadline,
        settings,
      )
    : buildExactInputSwapData(
        amountIn,
        amountOutMinimum,
        recipient,
        deadline,
        settings,
        input,
      )
}

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
])

export interface SwapTokenToBzzOptions {
  originPrivateKey: `0x${string}`
  /** What is being spent, and how much of it in that token's own units. */
  input: TokenInput
  amount: bigint
  /** BZZ recipient — for postage flows, the batch-owner address itself. */
  recipient: `0x${string}`
}

/**
 * Swap an ERC20 the owner already holds for BZZ.
 *
 * Unlike the native path there is an approval first, and it is set to exactly
 * this swap's amount: the owner key goes on signing postage operations for the
 * life of the drive, so an allowance to the router must not outlive the swap.
 */
export async function swapTokenToBzz(
  options: SwapTokenToBzzOptions,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<`0x${string}`> {
  const sushi = requireSushi(settings)
  const account = privateKeyToAccount(options.originPrivateKey)
  const pool = directPool(options.input, settings)
  const publicClient = publicClientFor(settings, rpcProvider)
  const client = walletClientFor(settings, rpcProvider)

  const allowance = await publicClient.readContract({
    address: pool.tokenIn,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, sushi.router],
  })
  let nonce = await getTransactionCount(account.address, settings, rpcProvider)
  if (allowance < options.amount) {
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [sushi.router, options.amount],
    })
    const approveHash = await withFeeTooLowRetry(async () => {
      const serializedTransaction = await account.signTransaction({
        chainId: settings.chainId,
        gas: await publicClient.estimateGas({
          account: account.address,
          to: pool.tokenIn,
          data: approveData,
        }),
        gasPrice: await getGasPrice(settings, rpcProvider),
        type: "legacy",
        to: pool.tokenIn,
        data: approveData,
        nonce,
      })
      return client.sendRawTransaction({ serializedTransaction })
    })
    // The swap's own gas estimate simulates the transfer, which reverts while
    // the allowance is still the old one — so wait rather than pipeline.
    await publicClient.waitForTransactionReceipt({ hash: approveHash })
    nonce += 1
  }

  const expected = await bestExactInput(
    options.amount,
    settings,
    rpcProvider,
    options.input,
  )
  const deadline = BigInt(
    Math.floor(Date.now() / MILLIS_PER_SECOND) + DEADLINE_SECONDS,
  )
  const data = buildSwapData(
    expected.route,
    options.amount,
    (expected.amount * SLIPPAGE_NUMERATOR) / SLIPPAGE_DENOMINATOR,
    options.recipient,
    deadline,
    settings,
    options.input,
  )
  const gasEstimate = await publicClient.estimateGas({
    account: account.address,
    to: sushi.router,
    data,
  })
  return withFeeTooLowRetry(async () => {
    const serializedTransaction = await account.signTransaction({
      chainId: settings.chainId,
      gas: (gasEstimate * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR,
      gasPrice: await getGasPrice(settings, rpcProvider),
      type: "legacy",
      to: sushi.router,
      data,
      nonce,
    })
    return client.sendRawTransaction({ serializedTransaction })
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
 * Swap native xDAI for BZZ on SushiSwap V3, through whichever of the two
 * routes fills better. Quotes first and applies 0.5% slippage tolerance;
 * reverts (deadline 10min) rather than filling badly.
 */
export async function swapXdaiToBzz(
  options: SwapXdaiToBzzOptions,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<`0x${string}`> {
  const sushi = requireSushi(settings)
  const account = privateKeyToAccount(options.originPrivateKey)
  // The route is decided and executed together. Quoting one route and swapping
  // through the other would spend the whole slippage budget on the difference
  // between two pools, which is far wider than the 0.5% bound.
  const expected = await bestExactInput(
    options.amountXdai,
    settings,
    rpcProvider,
  )
  const amountOutMinimum =
    (expected.amount * SLIPPAGE_NUMERATOR) / SLIPPAGE_DENOMINATOR
  const deadline = BigInt(
    Math.floor(Date.now() / MILLIS_PER_SECOND) + DEADLINE_SECONDS,
  )
  const data = buildSwapData(
    expected.route,
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

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Postage operations as ONE atomic transaction, via EIP-7702.
 *
 * Extend is approve + topUp; resize is approve + topUp + increaseDepth. Sent
 * separately, each boundary is a place the flow can stop half-done — the
 * reachable partial state the resize dialog has to explain and recover from.
 * Bundled, there is no boundary: the whole thing lands or none of it does.
 *
 * The owner EOA authorises a delegate (`settings.addresses.eip7702Delegate`)
 * and the transaction is sent from the EOA **to itself**, so inside the batch
 * `msg.sender` is still the owner. That matters beyond convenience: `topUp`
 * pulls BZZ from `msg.sender`, and `increaseDepth` is owner-only, so nothing
 * else could stand in.
 *
 * ORDER IS LOAD-BEARING, and atomicity does not rescue it. `increaseDepth`
 * checks the post-dilution per-chunk balance against the contract's minimum
 * BEFORE any compensation, so a bundle that dilutes before topping up reverts
 * exactly as the sequential version did — verified on chain, not assumed.
 */

import { RollingValueProvider } from "cafe-utility"
import { encodeFunctionData } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { ACCOUNT_7702_ABI, ERC20_ABI, POSTAGE_STAMP_ABI } from "./abi"
import { jsonRpc } from "./fetch"
import { getGasPrice, getTransactionCount } from "./rpc"
import type { MultichainSettings } from "./settings"
import { walletClientFor } from "./chain"
import { withFeeTooLowRetry } from "./write-retry"

/** One call inside the bundle. */
interface BundledCall {
  target: `0x${string}`
  value: bigint
  data: `0x${string}`
}

/**
 * Covers approve + topUp + increaseDepth together. Measured at ~420k for the
 * full resize bundle on a real batch; the headroom absorbs `increaseDepth`'s
 * internal expired-batch sweep, whose cost varies with the chain's backlog.
 */
const BUNDLE_GAS = 1_200_000n

export interface ExtendBundleOptions {
  /** The batch owner's key — authority, sender and `msg.sender` alike. */
  originPrivateKey: `0x${string}`
  batchId: `0x${string}`
  /** Per-chunk PLUR to top up. */
  amountPerChunk: bigint
  /** Total PLUR the top-up will pull — approved exactly, never unlimited. */
  totalPlur: bigint
}

export interface ResizeBundleOptions extends ExtendBundleOptions {
  newDepth: number
}

/**
 * Whether this chain can run a bundle — i.e. whether the delegate is deployed
 * on it. False is not an error: the caller falls back to sending the operations
 * one at a time, which is the same work with recoverable seams in between.
 *
 * Deliberately not cached, though the answer is stable in production. One
 * `eth_getCode` is nothing beside the transaction it precedes, and caching it
 * would make the delegate impossible to add or remove under a running client —
 * which is exactly what the tests covering the fallback path do.
 */
export async function supportsBundling(
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<boolean> {
  const code = await jsonRpc(rpcProvider, settings, "eth_getCode", [
    settings.addresses.eip7702Delegate,
    "latest",
  ]).catch(() => "0x")
  return typeof code === "string" && code !== "0x"
}

async function sendBundle(
  originPrivateKey: `0x${string}`,
  calls: BundledCall[],
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(originPrivateKey)
  const client = walletClientFor(settings, rpcProvider)

  return withFeeTooLowRetry(async () => {
    const nonce = await getTransactionCount(
      account.address,
      settings,
      rpcProvider,
    )
    // The authorization is applied AFTER this transaction's own nonce bump,
    // so when the sender is also the authority its nonce is one ahead. Signing
    // it with `nonce` instead silently produces a transaction that executes
    // against a bare EOA — no code, no revert, no batch.
    const authorization = await account.signAuthorization({
      chainId: settings.chainId,
      address: settings.addresses.eip7702Delegate,
      nonce: nonce + 1,
    })
    const serializedTransaction = await account.signTransaction({
      type: "eip7702",
      chainId: settings.chainId,
      authorizationList: [authorization],
      // To ITSELF: the delegate's code runs in the EOA's context, which is what
      // keeps `msg.sender` the batch owner throughout.
      to: account.address,
      data: encodeFunctionData({
        abi: ACCOUNT_7702_ABI,
        functionName: "executeBatch",
        args: [calls],
      }),
      gas: BUNDLE_GAS,
      maxFeePerGas: await getGasPrice(settings, rpcProvider),
      maxPriorityFeePerGas: 0n,
      nonce,
    })
    return client.sendRawTransaction({ serializedTransaction })
  })
}

function approveCall(
  settings: MultichainSettings,
  totalPlur: bigint,
): BundledCall {
  return {
    target: settings.addresses.bzz,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [settings.addresses.postageStamp, totalPlur],
    }),
  }
}

function topUpCall(
  settings: MultichainSettings,
  batchId: `0x${string}`,
  amountPerChunk: bigint,
): BundledCall {
  return {
    target: settings.addresses.postageStamp,
    value: 0n,
    data: encodeFunctionData({
      abi: POSTAGE_STAMP_ABI,
      functionName: "topUp",
      args: [batchId, amountPerChunk],
    }),
  }
}

/** approve + topUp, atomically. */
export function bundleExtend(
  options: ExtendBundleOptions,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<`0x${string}`> {
  return sendBundle(
    options.originPrivateKey,
    [
      approveCall(settings, options.totalPlur),
      topUpCall(settings, options.batchId, options.amountPerChunk),
    ],
    settings,
    rpcProvider,
  )
}

/**
 * approve + topUp + increaseDepth, atomically — and in that order, which the
 * contract requires (see the module comment).
 */
export function bundleResize(
  options: ResizeBundleOptions,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<`0x${string}`> {
  const increaseDepthCall: BundledCall = {
    target: settings.addresses.postageStamp,
    value: 0n,
    data: encodeFunctionData({
      abi: POSTAGE_STAMP_ABI,
      functionName: "increaseDepth",
      args: [options.batchId, options.newDepth],
    }),
  }
  // A resize that keeps no lifespan needs no top-up at all; approving and
  // topping up zero would just be two wasted calls inside the bundle.
  const calls: BundledCall[] =
    options.amountPerChunk > 0n
      ? [
          approveCall(settings, options.totalPlur),
          topUpCall(settings, options.batchId, options.amountPerChunk),
          increaseDepthCall,
        ]
      : [increaseDepthCall]
  return sendBundle(options.originPrivateKey, calls, settings, rpcProvider)
}

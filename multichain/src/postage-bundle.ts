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

import { RollingValueProvider, System } from "cafe-utility"
import { encodeFunctionData } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { ACCOUNT_7702_ABI, ERC20_ABI, POSTAGE_STAMP_ABI } from "./abi"
import { jsonRpc } from "./fetch"
import { getGasPrice, getTransactionCount, getTransactionReceipt } from "./rpc"
import type { CreateBatchResult } from "./postage-write"
import type { MultichainSettings } from "./settings"
import { walletClientFor } from "./chain"
import { withFeeTooLowRetry } from "./write-retry"

/** One call inside the bundle. */
export interface BundledCall {
  target: `0x${string}`
  value: bigint
  data: `0x${string}`
}

/**
 * Covers approve + topUp + increaseDepth together. Measured at ~420k for the
 * full resize bundle on a real batch; the headroom absorbs `increaseDepth`'s
 * internal expired-batch sweep, whose cost varies with the chain's backlog.
 *
 * Exported because it is half of what an operation must be funded for: a
 * transaction is only sendable with a balance of `gas × maxFeePerGas`, so the
 * caller sizing the gas budget has to price THIS number against the chain's
 * current gas price rather than guess at it.
 */
export const BUNDLE_GAS = 1_200_000n

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

export interface CreateBundleOptions {
  /** The buyer's key. Creator AND owner — see `bundleCreate`. */
  originPrivateKey: `0x${string}`
  /** Initial balance per chunk, in PLUR. */
  amountPerChunk: bigint
  depth: number
  bucketDepth: number
  /** 32-byte hex; batchId = keccak256(creator, nonce). */
  batchNonce: `0x${string}`
  immutable: boolean
  /** Total PLUR createBatch will pull — approved exactly, never unlimited. */
  totalPlur: bigint
}

/**
 * Whether this chain can run a bundle — i.e. whether the delegate is deployed
 * on it.
 *
 * False means the delegate is genuinely absent. An unreachable or erroring
 * endpoint THROWS rather than reporting absence: there is no sequential
 * fallback any more, so the caller refuses the operation on false, and a
 * transient RPC failure must not read as "this chain cannot pay atomically".
 *
 * Deliberately not cached, though the answer is stable in production. One
 * `eth_getCode` is nothing beside the transaction it precedes, and caching it
 * would make the delegate impossible to add under a running client — which is
 * what local dev does on first run.
 */
export async function supportsBundling(
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<boolean> {
  const code = await jsonRpc(rpcProvider, settings, "eth_getCode", [
    settings.addresses.eip7702Delegate,
    "latest",
  ])
  if (typeof code !== "string") {
    throw new Error(
      "The chain did not report whether it carries the 7702 delegate.",
    )
  }
  return code !== "0x"
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

/**
 * Buy a batch as ONE atomic transaction: approve + createBatch.
 *
 * The buyer is creator *and* owner. The multichain widget cannot do that — it
 * has no persistent key, so it creates from a throwaway wallet and passes
 * ownership across, leaving dust to sweep. The derived postage signer is
 * durable, so it simply keeps what it buys.
 *
 * @returns the new batch id, read from the BatchCreated event.
 */
export async function bundleCreate(
  options: CreateBundleOptions,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<CreateBatchResult> {
  const transactionHash = await sendBundle(
    options.originPrivateKey,
    createCalls(options, settings),
    settings,
    rpcProvider,
  )

  for (let i = 0; i < settings.receiptPollAttempts; i++) {
    await System.sleepMillis(settings.receiptPollMillis)
    const receipt = await getTransactionReceipt(
      transactionHash,
      settings,
      rpcProvider,
    )
    if (!receipt) {
      continue
    }
    // The batch id is the BatchCreated event's first indexed argument. Inside a
    // bundle the approve emits an Approval, and the token pull a Transfer, from
    // the BZZ contract — so match on the emitting contract rather than taking
    // the first log.
    const batchId = receipt.logs.find(
      (log) =>
        log.address.toLowerCase() ===
        settings.addresses.postageStamp.toLowerCase(),
    )?.topics[1]
    if (!batchId) {
      throw new Error(
        "createBatch bundle mined without a BatchCreated event (reverted?)",
      )
    }
    return { transactionHash, batchId }
  }
  throw new Error("Timed out waiting for the createBatch bundle receipt.")
}

/**
 * approve + createBatch, in that order — the approve has to exist before
 * `createBatch` pulls against it.
 */
export function createCalls(
  options: CreateBundleOptions,
  settings: MultichainSettings,
): BundledCall[] {
  const owner = privateKeyToAccount(options.originPrivateKey).address
  return [
    approveCall(settings, options.totalPlur),
    {
      target: settings.addresses.postageStamp,
      value: 0n,
      data: encodeFunctionData({
        abi: POSTAGE_STAMP_ABI,
        functionName: "createBatch",
        args: [
          owner,
          options.amountPerChunk,
          options.depth,
          options.bucketDepth,
          options.batchNonce,
          options.immutable,
        ],
      }),
    },
  ]
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

/** approve + topUp, in that order. */
export function extendCalls(
  options: ExtendBundleOptions,
  settings: MultichainSettings,
): BundledCall[] {
  return [
    approveCall(settings, options.totalPlur),
    topUpCall(settings, options.batchId, options.amountPerChunk),
  ]
}

/**
 * approve + topUp + increaseDepth, in the order the contract requires (see the
 * module comment) — or `increaseDepth` alone when there is no lifespan to keep.
 *
 * Pure, and exported, because the ORDER is the load-bearing part: it is a
 * property of these three calls, not of the transaction that carries them, so
 * it can be pinned without a chain. `postage-bundle.test.ts` does exactly that.
 */
export function resizeCalls(
  options: ResizeBundleOptions,
  settings: MultichainSettings,
): BundledCall[] {
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
  if (options.amountPerChunk === 0n) {
    return [increaseDepthCall]
  }
  return [
    approveCall(settings, options.totalPlur),
    topUpCall(settings, options.batchId, options.amountPerChunk),
    increaseDepthCall,
  ]
}

/** approve + topUp, atomically. */
export function bundleExtend(
  options: ExtendBundleOptions,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<`0x${string}`> {
  return sendBundle(
    options.originPrivateKey,
    extendCalls(options, settings),
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
  return sendBundle(
    options.originPrivateKey,
    resizeCalls(options, settings),
    settings,
    rpcProvider,
  )
}

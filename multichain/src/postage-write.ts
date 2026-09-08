// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { RollingValueProvider, System } from "cafe-utility"
import { privateKeyToAccount } from "viem/accounts"
import { POSTAGE_STAMP_ABI } from "./abi"
import { chainFromSettings, publicClientFor, walletClientFor } from "./chain"
import { getGasPrice, getTransactionCount, getTransactionReceipt } from "./rpc"
import type { MultichainSettings } from "./settings"
import { withFeeTooLowRetry } from "./write-retry"

/**
 * Estimated per call, with the same quarter margin the swap uses. The widget's
 * fixed 1.2M budget was measured at ~340-590k, but every PostageStamp write
 * first sweeps expired batches, and that sweep grows with the chain's backlog:
 * on a long-running dev chain `createBatch` was mined out of gas at 1.2M
 * (estimate 1.37M), which surfaces as "mined without a BatchCreated event".
 * An estimate also fails BEFORE sending when the call would revert, with the
 * contract's reason instead of a silent receipt.
 */
const GAS_BUFFER_NUMERATOR = 5n
const GAS_BUFFER_DENOMINATOR = 4n

function withGasMargin(estimate: bigint): bigint {
  return (estimate * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR
}

export interface CreateBatchOptions {
  originPrivateKey: `0x${string}`
  /** PostageStamp-level batch owner — NOT necessarily the transaction sender. */
  owner: `0x${string}`
  depth: number
  /** Initial balance per chunk in PLUR. */
  amount: bigint
  bucketDepth: number
  /** 32-byte hex nonce; batchId = keccak256(sender, nonce). */
  batchNonce: `0x${string}`
  immutable: boolean
  nonce?: number
}

export interface CreateBatchResult {
  transactionHash: `0x${string}`
  batchId: `0x${string}`
}

/**
 * Create a batch and return its id, extracted from the BatchCreated event in
 * the receipt (first indexed topic). The sender must hold enough BZZ and have
 * approved the PostageStamp contract for `amount << depth` PLUR.
 */
export async function createBatch(
  options: CreateBatchOptions,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<CreateBatchResult> {
  const account = privateKeyToAccount(options.originPrivateKey)
  const client = walletClientFor(settings, rpcProvider)
  const args = [
    options.owner,
    options.amount,
    options.depth,
    options.bucketDepth,
    options.batchNonce,
    options.immutable,
  ] as const
  const gas = withGasMargin(
    await publicClientFor(settings, rpcProvider).estimateContractGas({
      account,
      abi: POSTAGE_STAMP_ABI,
      address: settings.addresses.postageStamp,
      functionName: "createBatch",
      args,
    }),
  )
  const transactionHash = await withFeeTooLowRetry(async () =>
    client.writeContract({
      account,
      abi: POSTAGE_STAMP_ABI,
      address: settings.addresses.postageStamp,
      functionName: "createBatch",
      args,
      gas,
      gasPrice: await getGasPrice(settings, rpcProvider),
      type: "legacy",
      chain: chainFromSettings(settings),
      nonce:
        options.nonce ??
        (await getTransactionCount(account.address, settings, rpcProvider)),
    }),
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
    const event = receipt.logs.find(
      (log) =>
        log.address.toLowerCase() ===
        settings.addresses.postageStamp.toLowerCase(),
    )
    const batchId = event?.topics[1]
    if (batchId) {
      return { transactionHash, batchId }
    }
    throw new Error(
      "createBatch transaction mined without a BatchCreated event (reverted?)",
    )
  }
  throw new Error("Timed out waiting for the createBatch transaction receipt.")
}

export interface TopUpBatchOptions {
  originPrivateKey: `0x${string}`
  batchId: `0x${string}`
  /**
   * Additional balance PER CHUNK in PLUR — the contract pulls
   * `amountPerChunk << depth` in total from the sender, who must have
   * approved the PostageStamp contract for at least that.
   */
  amountPerChunk: bigint
  nonce?: number
}

/** Permissionless on-chain top-up. Await the receipt via waiter.ts. */
export async function topUpBatch(
  options: TopUpBatchOptions,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(options.originPrivateKey)
  const client = walletClientFor(settings, rpcProvider)
  const args = [options.batchId, options.amountPerChunk] as const
  const gas = withGasMargin(
    await publicClientFor(settings, rpcProvider).estimateContractGas({
      account,
      abi: POSTAGE_STAMP_ABI,
      address: settings.addresses.postageStamp,
      functionName: "topUp",
      args,
    }),
  )
  return withFeeTooLowRetry(async () =>
    client.writeContract({
      account,
      abi: POSTAGE_STAMP_ABI,
      address: settings.addresses.postageStamp,
      functionName: "topUp",
      args,
      gas,
      gasPrice: await getGasPrice(settings, rpcProvider),
      type: "legacy",
      chain: chainFromSettings(settings),
      nonce:
        options.nonce ??
        (await getTransactionCount(account.address, settings, rpcProvider)),
    }),
  )
}

export interface IncreaseDepthOptions {
  /**
   * MUST be the batch owner's key — the contract reverts NotBatchOwner for
   * any other sender. Transfers no tokens; only gas is spent.
   */
  originPrivateKey: `0x${string}`
  batchId: `0x${string}`
  newDepth: number
  nonce?: number
}

/**
 * Owner-only dilution. The contract requires the post-dilution per-chunk
 * balance to clear minimumInitialBalancePerChunk() BEFORE any compensation,
 * so run the compensating topUpBatch FIRST when preserving lifespan.
 */
export async function increaseDepth(
  options: IncreaseDepthOptions,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(options.originPrivateKey)
  const client = walletClientFor(settings, rpcProvider)
  const args = [options.batchId, options.newDepth] as const
  const gas = withGasMargin(
    await publicClientFor(settings, rpcProvider).estimateContractGas({
      account,
      abi: POSTAGE_STAMP_ABI,
      address: settings.addresses.postageStamp,
      functionName: "increaseDepth",
      args,
    }),
  )
  return withFeeTooLowRetry(async () =>
    client.writeContract({
      account,
      abi: POSTAGE_STAMP_ABI,
      address: settings.addresses.postageStamp,
      functionName: "increaseDepth",
      args,
      gas,
      gasPrice: await getGasPrice(settings, rpcProvider),
      type: "legacy",
      chain: chainFromSettings(settings),
      nonce:
        options.nonce ??
        (await getTransactionCount(account.address, settings, rpcProvider)),
    }),
  )
}

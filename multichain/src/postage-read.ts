// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { RollingValueProvider } from "cafe-utility"
import { POSTAGE_STAMP_ABI } from "./abi"
import { publicClientFor } from "./chain"
import type { MultichainSettings } from "./settings"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/** Decoded `batches(batchId)` tuple; mirrors the contract's Batch struct. */
export interface PostageBatch {
  owner: `0x${string}`
  depth: number
  bucketDepth: number
  immutableFlag: boolean
  normalisedBalance: bigint
  lastUpdatedBlockNumber: bigint
}

/** @returns the batch, or undefined when the contract has no such batch. */
export async function getPostageBatch(
  batchId: `0x${string}`,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<PostageBatch | undefined> {
  const client = publicClientFor(settings, rpcProvider)
  const [
    owner,
    depth,
    bucketDepth,
    immutableFlag,
    normalisedBalance,
    lastUpdatedBlockNumber,
  ] = await client.readContract({
    address: settings.addresses.postageStamp,
    abi: POSTAGE_STAMP_ABI,
    functionName: "batches",
    args: [batchId],
  })
  if (owner === ZERO_ADDRESS) {
    return undefined
  }
  return {
    owner,
    depth,
    bucketDepth,
    immutableFlag,
    normalisedBalance,
    lastUpdatedBlockNumber,
  }
}

/**
 * Live per-chunk balance in PLUR — the quantity increaseDepth divides and the
 * one all resize planning must start from (never a stored snapshot).
 * @throws when the batch does not exist (contract BatchDoesNotExist revert);
 *   returns 0n for an expired-but-not-yet-swept batch.
 */
export async function getRemainingBalance(
  batchId: `0x${string}`,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<bigint> {
  const client = publicClientFor(settings, rpcProvider)
  return client.readContract({
    address: settings.addresses.postageStamp,
    abi: POSTAGE_STAMP_ABI,
    functionName: "remainingBalance",
    args: [batchId],
  })
}

/** Everything a write preflight needs, in one round of reads. */
export interface PostageWriteConstraints {
  paused: boolean
  /** ~24h of storage at the current price; floor for topUp/increaseDepth. */
  minimumInitialBalancePerChunk: bigint
  /** PLUR per chunk per block. */
  lastPrice: bigint
}

export async function getPostageWriteConstraints(
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<PostageWriteConstraints> {
  const client = publicClientFor(settings, rpcProvider)
  const contract = {
    address: settings.addresses.postageStamp,
    abi: POSTAGE_STAMP_ABI,
  } as const
  const [paused, minimumInitialBalancePerChunk, lastPrice] = await Promise.all([
    client.readContract({ ...contract, functionName: "paused" }),
    client.readContract({
      ...contract,
      functionName: "minimumInitialBalancePerChunk",
    }),
    client.readContract({ ...contract, functionName: "lastPrice" }),
  ])
  return {
    paused,
    minimumInitialBalancePerChunk,
    lastPrice: BigInt(lastPrice),
  }
}

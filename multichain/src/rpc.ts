// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { RollingValueProvider, Types } from "cafe-utility"
import { jsonRpc, jsonRpcOrUndefined } from "./fetch"
import type { MultichainSettings } from "./settings"

export interface TransactionReceipt {
  blockNumber: `0x${string}`
  from: `0x${string}`
  gasUsed: `0x${string}`
  /** "0x1" success, "0x0" revert. */
  status: `0x${string}`
  to: `0x${string}`
  transactionHash: `0x${string}`
  logs: Array<{ address: `0x${string}`; topics: `0x${string}`[] }>
}

/** @returns the receipt, or undefined while the transaction is still pending. */
export async function getTransactionReceipt(
  transactionHash: `0x${string}`,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<TransactionReceipt | undefined> {
  // Null-tolerant: a pending transaction has no receipt yet, and JSON-RPC says
  // so with `result: null` — the normal answer here, not a failed read.
  const result = await jsonRpcOrUndefined(
    rpcProvider,
    settings,
    "eth_getTransactionReceipt",
    [transactionHash],
  ).catch(() => undefined)
  if (result === undefined) {
    return undefined
  }
  return Types.asObject(result) as unknown as TransactionReceipt
}

/** Pending-block nonce, so sequential sends chain without waiting. */
export async function getTransactionCount(
  address: `0x${string}`,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<number> {
  const result = await jsonRpc(
    rpcProvider,
    settings,
    "eth_getTransactionCount",
    [address, "pending"],
  )
  return Number(BigInt(Types.asString(result)))
}

export async function getGasPrice(
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<bigint> {
  const result = await jsonRpc(rpcProvider, settings, "eth_gasPrice", [])
  return BigInt(Types.asString(result))
}

/**
 * What the endpoint suggests as a priority fee, or zero where it will not say.
 *
 * Zero is a legitimate answer — an idle mempool has nothing to outbid — and an
 * endpoint may not implement the method at all, so neither case is worth
 * failing a payment over. `bundleFeeFields` floors whatever comes back, which
 * is where the guarantee that we never offer nothing actually lives.
 */
export async function getMaxPriorityFeePerGas(
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<bigint> {
  try {
    const result = await jsonRpc(
      rpcProvider,
      settings,
      "eth_maxPriorityFeePerGas",
      [],
    )
    return BigInt(Types.asString(result))
  } catch {
    return 0n
  }
}

/**
 * Gas for a plain native transfer to `to`.
 *
 * NOT the 21 000 a transfer to an EOA costs: once an address has authorised an
 * EIP-7702 delegate — which every postage signer does the first time it runs a
 * bundled operation — a transfer to it EXECUTES that delegate's fallback, and
 * 21 000 runs out of gas. The transaction then reverts, which reads as "the
 * money never arrived" wherever it lands: a faucet top-up, or the local
 * solver's delivery to a batch owner that has already bought once.
 */
export async function estimateTransferGas(
  from: `0x${string}`,
  to: `0x${string}`,
  value: bigint,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<bigint> {
  const result = await jsonRpc(rpcProvider, settings, "eth_estimateGas", [
    { from, to, value: `0x${value.toString(16)}` },
  ])
  return BigInt(Types.asString(result))
}

export async function getChainId(
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<number> {
  const result = await jsonRpc(rpcProvider, settings, "eth_chainId", [])
  return Number(BigInt(Types.asString(result)))
}

export async function getNativeBalance(
  address: `0x${string}`,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<bigint> {
  const result = await jsonRpc(rpcProvider, settings, "eth_getBalance", [
    address,
    "latest",
  ])
  return BigInt(Types.asString(result))
}

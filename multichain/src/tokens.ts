// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { RollingValueProvider } from "cafe-utility"
import { privateKeyToAccount } from "viem/accounts"
import { ERC20_ABI } from "./abi"
import { chainFromSettings, publicClientFor, walletClientFor } from "./chain"
import { estimateTransferGas, getGasPrice, getTransactionCount } from "./rpc"
import type { MultichainSettings } from "./settings"
import { withFeeTooLowRetry } from "./write-retry"

/**
 * Headroom on the estimate for a native transfer. An estimate is exact for the
 * block it was made against, and a delegated recipient's fallback is executed
 * code — cheap here, but not a constant we should bet the delivery on.
 */
const NATIVE_TRANSFER_GAS_MARGIN = 2n
const ERC20_GAS = 100_000n

/** BZZ token balance in PLUR (the token's base unit; 1 BZZ = 1e16 PLUR). */
export async function getBzzBalance(
  address: `0x${string}`,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<bigint> {
  const client = publicClientFor(settings, rpcProvider)
  return client.readContract({
    address: settings.addresses.bzz,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  })
}

export async function getBzzAllowance(
  owner: `0x${string}`,
  spender: `0x${string}`,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<bigint> {
  const client = publicClientFor(settings, rpcProvider)
  return client.readContract({
    address: settings.addresses.bzz,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  })
}

export interface TransferNativeOptions {
  amount: bigint
  originPrivateKey: `0x${string}`
  to: `0x${string}`
  nonce?: number
}

export async function transferNative(
  options: TransferNativeOptions,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(options.originPrivateKey)
  const client = walletClientFor(settings, rpcProvider)
  const gas = await estimateTransferGas(
    account.address,
    options.to,
    options.amount,
    settings,
    rpcProvider,
  )
  return withFeeTooLowRetry(async () => {
    const serializedTransaction = await account.signTransaction({
      chainId: settings.chainId,
      gas: gas * NATIVE_TRANSFER_GAS_MARGIN,
      gasPrice: await getGasPrice(settings, rpcProvider),
      type: "legacy",
      to: options.to,
      value: options.amount,
      nonce:
        options.nonce ??
        (await getTransactionCount(account.address, settings, rpcProvider)),
    })
    return client.sendRawTransaction({ serializedTransaction })
  })
}

export interface TransferBzzOptions {
  /** Amount in PLUR. */
  amount: bigint
  originPrivateKey: `0x${string}`
  to: `0x${string}`
  nonce?: number
}

export async function transferBzz(
  options: TransferBzzOptions,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(options.originPrivateKey)
  const client = walletClientFor(settings, rpcProvider)
  return withFeeTooLowRetry(async () =>
    client.writeContract({
      account,
      abi: ERC20_ABI,
      address: settings.addresses.bzz,
      functionName: "transfer",
      args: [options.to, options.amount],
      gas: ERC20_GAS,
      gasPrice: await getGasPrice(settings, rpcProvider),
      type: "legacy",
      chain: chainFromSettings(settings),
      nonce:
        options.nonce ??
        (await getTransactionCount(account.address, settings, rpcProvider)),
    }),
  )
}

export interface ApproveBzzOptions {
  /** Allowance in PLUR — approve exactly what the operation needs. */
  amount: bigint
  originPrivateKey: `0x${string}`
  spender: `0x${string}`
  nonce?: number
}

export async function approveBzz(
  options: ApproveBzzOptions,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(options.originPrivateKey)
  const client = walletClientFor(settings, rpcProvider)
  return withFeeTooLowRetry(async () =>
    client.writeContract({
      account,
      abi: ERC20_ABI,
      address: settings.addresses.bzz,
      functionName: "approve",
      args: [options.spender, options.amount],
      gas: ERC20_GAS,
      gasPrice: await getGasPrice(settings, rpcProvider),
      type: "legacy",
      chain: chainFromSettings(settings),
      nonce:
        options.nonce ??
        (await getTransactionCount(account.address, settings, rpcProvider)),
    }),
  )
}

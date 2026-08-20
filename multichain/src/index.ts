// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { RollingValueProvider } from "cafe-utility"
import {
  type CreateBundleOptions,
  type ExtendBundleOptions,
  type ResizeBundleOptions,
  bundleCreate,
  bundleExtend,
  bundleResize,
  supportsBundling,
} from "./postage-bundle"
import {
  getBzzAllowance,
  getBzzBalance,
  approveBzz,
  transferBzz,
  transferNative,
  type ApproveBzzOptions,
  type TransferBzzOptions,
  type TransferNativeOptions,
} from "./tokens"
import {
  getChainId,
  getGasPrice,
  getNativeBalance,
  getTransactionReceipt,
  type TransactionReceipt,
} from "./rpc"
import {
  createBatch,
  increaseDepth,
  topUpBatch,
  type CreateBatchOptions,
  type CreateBatchResult,
  type IncreaseDepthOptions,
  type TopUpBatchOptions,
} from "./postage-write"
import {
  getPostageBatch,
  getPostageWriteConstraints,
  getRemainingBalance,
  type PostageBatch,
  type PostageWriteConstraints,
} from "./postage-read"
import {
  quoteBzzOutForXdaiIn,
  quoteXdaiInForBzzOut,
  swapXdaiToBzz,
  type SwapXdaiToBzzOptions,
} from "./sushi"
import type { MultichainSettings } from "./settings"
import {
  waitForBzzBalanceAtLeast,
  waitForNativeBalanceAtLeast,
  waitForTransactionSuccess,
} from "./waiter"

export { gnosisMainnetSettings, GNOSIS_CHAIN_ID } from "./settings"
export type { MultichainAddresses, MultichainSettings } from "./settings"
export type {
  CreateBatchOptions,
  CreateBatchResult,
  IncreaseDepthOptions,
  TopUpBatchOptions,
} from "./postage-write"
export type { PostageBatch, PostageWriteConstraints } from "./postage-read"
export type { TransactionReceipt } from "./rpc"
export { POSTAGE_STAMP_ABI, ERC20_ABI, ACCOUNT_7702_ABI } from "./abi"
export type {
  CreateBundleOptions,
  ExtendBundleOptions,
  ResizeBundleOptions,
} from "./postage-bundle"
export { BUNDLE_GAS } from "./postage-bundle"
export { buildExactInputSwapData } from "./sushi"

/**
 * One client per chain configuration. Construct with `gnosisMainnetSettings()`
 * and optional overrides — every method then talks to that chain with rotating
 * RPC fallback.
 */
export class MultichainClient {
  readonly settings: MultichainSettings
  private readonly rpcProvider: RollingValueProvider<string>

  constructor(settings: MultichainSettings) {
    this.settings = settings
    this.rpcProvider = new RollingValueProvider(settings.rpcUrls)
  }

  /**
   * Whether postage operations can run as one atomic EIP-7702 bundle here.
   * False means the delegate is not deployed on this chain; the caller sends
   * the operations one at a time instead.
   */
  supportsBundling(): Promise<boolean> {
    return supportsBundling(this.settings, this.rpcProvider)
  }

  /** approve + topUp in one transaction. */
  bundleExtend(options: ExtendBundleOptions): Promise<`0x${string}`> {
    return bundleExtend(options, this.settings, this.rpcProvider)
  }

  /** approve + createBatch in one transaction; the buyer owns what it buys. */
  bundleCreate(options: CreateBundleOptions): Promise<CreateBatchResult> {
    return bundleCreate(options, this.settings, this.rpcProvider)
  }

  /** approve + topUp + increaseDepth in one transaction, in that order. */
  bundleResize(options: ResizeBundleOptions): Promise<`0x${string}`> {
    return bundleResize(options, this.settings, this.rpcProvider)
  }

  getChainId(): Promise<number> {
    return getChainId(this.settings, this.rpcProvider)
  }

  getGasPrice(): Promise<bigint> {
    return getGasPrice(this.settings, this.rpcProvider)
  }

  getNativeBalance(address: `0x${string}`): Promise<bigint> {
    return getNativeBalance(address, this.settings, this.rpcProvider)
  }

  getBzzBalance(address: `0x${string}`): Promise<bigint> {
    return getBzzBalance(address, this.settings, this.rpcProvider)
  }

  getBzzAllowance(
    owner: `0x${string}`,
    spender: `0x${string}`,
  ): Promise<bigint> {
    return getBzzAllowance(owner, spender, this.settings, this.rpcProvider)
  }

  getTransactionReceipt(
    transactionHash: `0x${string}`,
  ): Promise<TransactionReceipt | undefined> {
    return getTransactionReceipt(
      transactionHash,
      this.settings,
      this.rpcProvider,
    )
  }

  transferNative(options: TransferNativeOptions): Promise<`0x${string}`> {
    return transferNative(options, this.settings, this.rpcProvider)
  }

  transferBzz(options: TransferBzzOptions): Promise<`0x${string}`> {
    return transferBzz(options, this.settings, this.rpcProvider)
  }

  approveBzz(options: ApproveBzzOptions): Promise<`0x${string}`> {
    return approveBzz(options, this.settings, this.rpcProvider)
  }

  createBatch(options: CreateBatchOptions): Promise<CreateBatchResult> {
    return createBatch(options, this.settings, this.rpcProvider)
  }

  topUpBatch(options: TopUpBatchOptions): Promise<`0x${string}`> {
    return topUpBatch(options, this.settings, this.rpcProvider)
  }

  increaseDepth(options: IncreaseDepthOptions): Promise<`0x${string}`> {
    return increaseDepth(options, this.settings, this.rpcProvider)
  }

  getPostageBatch(batchId: `0x${string}`): Promise<PostageBatch | undefined> {
    return getPostageBatch(batchId, this.settings, this.rpcProvider)
  }

  getRemainingBalance(batchId: `0x${string}`): Promise<bigint> {
    return getRemainingBalance(batchId, this.settings, this.rpcProvider)
  }

  getPostageWriteConstraints(): Promise<PostageWriteConstraints> {
    return getPostageWriteConstraints(this.settings, this.rpcProvider)
  }

  quoteXdaiInForBzzOut(bzzOut: bigint): Promise<bigint> {
    return quoteXdaiInForBzzOut(bzzOut, this.settings, this.rpcProvider)
  }

  quoteBzzOutForXdaiIn(xdaiIn: bigint): Promise<bigint> {
    return quoteBzzOutForXdaiIn(xdaiIn, this.settings, this.rpcProvider)
  }

  swapXdaiToBzz(options: SwapXdaiToBzzOptions): Promise<`0x${string}`> {
    return swapXdaiToBzz(options, this.settings, this.rpcProvider)
  }

  waitForTransactionSuccess(transactionHash: `0x${string}`): Promise<void> {
    return waitForTransactionSuccess(
      transactionHash,
      this.settings,
      this.rpcProvider,
    )
  }

  waitForBzzBalanceAtLeast(
    address: `0x${string}`,
    minimum: bigint,
  ): Promise<void> {
    return waitForBzzBalanceAtLeast(
      address,
      minimum,
      this.settings,
      this.rpcProvider,
    )
  }

  waitForNativeBalanceAtLeast(
    address: `0x${string}`,
    minimum: bigint,
  ): Promise<void> {
    return waitForNativeBalanceAtLeast(
      address,
      minimum,
      this.settings,
      this.rpcProvider,
    )
  }
}

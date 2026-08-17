// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { RollingValueProvider, System } from "cafe-utility"
import { getNativeBalance, getTransactionReceipt } from "./rpc"
import type { MultichainSettings } from "./settings"
import { getBzzBalance } from "./tokens"

const SUCCESS_STATUS = 1

/**
 * Wait until the transaction is mined WITH status success.
 * @throws on timeout, and immediately when the receipt reports a revert —
 *   a reverted spend must surface, not be retried into.
 */
export async function waitForTransactionSuccess(
  transactionHash: `0x${string}`,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<void> {
  let reverted = false
  await System.waitFor(
    async () => {
      const receipt = await getTransactionReceipt(
        transactionHash,
        settings,
        rpcProvider,
      )
      if (!receipt) {
        return false
      }
      if (parseInt(receipt.status) !== SUCCESS_STATUS) {
        reverted = true
        return true
      }
      return true
    },
    {
      attempts: settings.receiptPollAttempts,
      waitMillis: settings.receiptPollMillis,
    },
  )
  if (reverted) {
    throw new Error(`Transaction ${transactionHash} reverted on-chain.`)
  }
}

export async function waitForBzzBalanceAtLeast(
  address: `0x${string}`,
  minimum: bigint,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<void> {
  await System.waitFor(
    async () =>
      (await getBzzBalance(address, settings, rpcProvider).catch(() => -1n)) >=
      minimum,
    {
      attempts: settings.balancePollAttempts,
      waitMillis: settings.balancePollMillis,
    },
  )
}

export async function waitForNativeBalanceAtLeast(
  address: `0x${string}`,
  minimum: bigint,
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): Promise<void> {
  await System.waitFor(
    async () =>
      (await getNativeBalance(address, settings, rpcProvider).catch(
        () => -1n,
      )) >= minimum,
    {
      attempts: settings.balancePollAttempts,
      waitMillis: settings.balancePollMillis,
    },
  )
}

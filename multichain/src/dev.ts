// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * LOCAL DEV / TEST ONLY — helpers for the bee-compose anvil chain.
 *
 * These stand in for the two legs that cannot run locally (no Relay, no DEX):
 * instead of a cross-chain payment + Sushi swap delivering funds, the
 * well-known queen dev account transfers xDAI and TestToken BZZ directly.
 * Production code must never import this module.
 */

import { RollingValueProvider } from "cafe-utility"
import { privateKeyToAccount } from "viem/accounts"
import { createBatch, type CreateBatchResult } from "./postage-write"
import { getNativeBalance } from "./rpc"
import type { MultichainSettings } from "./settings"
import { swapXdaiToBzz } from "./sushi"
import {
  approveBzz,
  getBzzBalance,
  transferBzz,
  transferNative,
} from "./tokens"
import { waitForTransactionSuccess } from "./waiter"

/** Left with the throwaway payer so its final transfer can pay for itself. */
const GAS_RESERVE_WEI = 10n ** 16n // 0.01 xDAI

/**
 * The bee-compose queen node's key (documented in .claude/rules/bee-cluster.md),
 * prefunded by the cluster with ~100 xDAI and 100k BZZ on the local anvil
 * chain. A publicly known development key — worthless outside localhost.
 */
export const LOCAL_DEV_FUNDER_PRIVATE_KEY: `0x${string}` =
  "0x566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9"

export const DEFAULT_BUCKET_DEPTH = 16

export interface FundLocalAccountOptions {
  to: `0x${string}`
  /** xDAI in wei; 0n skips the native transfer. */
  xdai: bigint
  /** BZZ in PLUR; 0n skips the token transfer. */
  bzzPlur: bigint
}

/**
 * Mock of the production funding leg: deliver xDAI (gas) and BZZ (value) to
 * an address — typically the derived batch-owner — from the queen account.
 */
export async function fundLocalAccount(
  options: FundLocalAccountOptions,
  settings: MultichainSettings,
): Promise<void> {
  const rpcProvider = new RollingValueProvider(settings.rpcUrls)
  if (options.xdai > 0n) {
    const hash = await transferNative(
      {
        amount: options.xdai,
        originPrivateKey: LOCAL_DEV_FUNDER_PRIVATE_KEY,
        to: options.to,
      },
      settings,
      rpcProvider,
    )
    await waitForTransactionSuccess(hash, settings, rpcProvider)
  }
  if (options.bzzPlur > 0n) {
    const hash = await transferBzz(
      {
        amount: options.bzzPlur,
        originPrivateKey: LOCAL_DEV_FUNDER_PRIVATE_KEY,
        to: options.to,
      },
      settings,
      rpcProvider,
    )
    await waitForTransactionSuccess(hash, settings, rpcProvider)
  }
}

export interface CreateLocalBatchOptions {
  /** PostageStamp-level batch owner (e.g. the derived postage signer). */
  owner: `0x${string}`
  depth: number
  /** Initial balance per chunk in PLUR. */
  amountPerChunk: bigint
}

const NONCE_BYTES = 32
const HEX_RADIX = 16

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const hex = Array.from(bytes)
    .map((byte) => byte.toString(HEX_RADIX).padStart(2, "0"))
    .join("")
  return `0x${hex}`
}

/**
 * Create a mutable batch on the local chain, paid for by the queen account,
 * owned by `owner` — mirroring production, where the widget's temp wallet is
 * the creator/payer and the derived signer is the owner. Gives extend/resize
 * a real owner-key batch to run against end-to-end.
 */
export async function createLocalBatch(
  options: CreateLocalBatchOptions,
  settings: MultichainSettings,
): Promise<CreateBatchResult> {
  const rpcProvider = new RollingValueProvider(settings.rpcUrls)
  const totalPlur = options.amountPerChunk << BigInt(options.depth)
  const approveHash = await approveBzz(
    {
      amount: totalPlur,
      originPrivateKey: LOCAL_DEV_FUNDER_PRIVATE_KEY,
      spender: settings.addresses.postageStamp,
    },
    settings,
    rpcProvider,
  )
  await waitForTransactionSuccess(approveHash, settings, rpcProvider)
  return createBatch(
    {
      originPrivateKey: LOCAL_DEV_FUNDER_PRIVATE_KEY,
      owner: options.owner,
      depth: options.depth,
      amount: options.amountPerChunk,
      bucketDepth: DEFAULT_BUCKET_DEPTH,
      batchNonce: randomNonce(),
      immutable: false,
    },
    settings,
    rpcProvider,
  )
}

// ============================================================================
// Gnosis fork (anvil --fork-url) — the closest local setup to production
// ============================================================================

/**
 * Mint native xDAI onto an address. Only anvil can do this, and it is the one
 * leg a fork cannot reproduce honestly: in production a cross-chain bridge
 * delivers this xDAI. Everything downstream runs against real contracts.
 */
export async function anvilSetBalance(
  rpcUrl: string,
  address: `0x${string}`,
  wei: bigint,
): Promise<void> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [address, `0x${wei.toString(16)}`],
    }),
  })
  const data = (await response.json()) as { error?: { message?: string } }
  if (data.error) {
    throw new Error(
      `anvil_setBalance failed: ${data.error.message ?? "unknown error"}`,
    )
  }
}

export interface SimulateWidgetPurchaseOptions {
  /** Batch owner — the account's postage signer, as `destination` in the widget. */
  owner: `0x${string}`
  depth: number
  /** Initial balance per chunk, in PLUR. */
  amountPerChunk: bigint
  /** xDAI to hand the throwaway payer; must cover the swap, the batch and gas. */
  payerXdai: bigint
  /** Fresh key playing the widget's per-session temporary wallet. */
  payerPrivateKey: `0x${string}`
  /** xDAI to spend on BZZ; the remainder stays for gas and the owner's dust. */
  swapXdai: bigint
}

export interface SimulatedPurchase extends CreateBatchResult {
  depth: number
  amountPerChunk: bigint
}

/**
 * Reproduce the multichain widget's Gnosis-side flow end to end against a
 * forked mainnet: a throwaway payer receives xDAI (the bridge stand-in), swaps
 * it for BZZ on the real SushiSwap pool, approves, creates the batch owned by
 * `owner`, then hands its leftovers over — exactly the widget's step list, run
 * through the same package functions production uses.
 */
export async function simulateWidgetPurchase(
  options: SimulateWidgetPurchaseOptions,
  settings: MultichainSettings,
): Promise<SimulatedPurchase> {
  const rpcProvider = new RollingValueProvider(settings.rpcUrls)
  const payer = privateKeyToAccount(options.payerPrivateKey).address

  await anvilSetBalance(rpcProvider.current(), payer, options.payerXdai)

  const swapHash = await swapXdaiToBzz(
    {
      originPrivateKey: options.payerPrivateKey,
      amountXdai: options.swapXdai,
      recipient: payer,
    },
    settings,
    rpcProvider,
  )
  await waitForTransactionSuccess(swapHash, settings, rpcProvider)

  const total = options.amountPerChunk << BigInt(options.depth)
  const approveHash = await approveBzz(
    {
      amount: total,
      originPrivateKey: options.payerPrivateKey,
      spender: settings.addresses.postageStamp,
    },
    settings,
    rpcProvider,
  )
  await waitForTransactionSuccess(approveHash, settings, rpcProvider)

  const created = await createBatch(
    {
      originPrivateKey: options.payerPrivateKey,
      owner: options.owner,
      depth: options.depth,
      amount: options.amountPerChunk,
      bucketDepth: DEFAULT_BUCKET_DEPTH,
      batchNonce: randomNonce(),
      immutable: false,
    },
    settings,
    rpcProvider,
  )

  // The widget hands what is left to the destination; the owner needs it to
  // sign its own top-ups and resizes.
  const leftoverBzz = await getBzzBalance(payer, settings, rpcProvider)
  if (leftoverBzz > 0n) {
    const hash = await transferBzz(
      {
        amount: leftoverBzz,
        originPrivateKey: options.payerPrivateKey,
        to: options.owner,
      },
      settings,
      rpcProvider,
    )
    await waitForTransactionSuccess(hash, settings, rpcProvider)
  }
  const leftoverXdai = await getNativeBalance(payer, settings, rpcProvider)
  if (leftoverXdai > GAS_RESERVE_WEI) {
    const hash = await transferNative(
      {
        amount: leftoverXdai - GAS_RESERVE_WEI,
        originPrivateKey: options.payerPrivateKey,
        to: options.owner,
      },
      settings,
      rpcProvider,
    )
    await waitForTransactionSuccess(hash, settings, rpcProvider)
  }

  return {
    ...created,
    depth: options.depth,
    amountPerChunk: options.amountPerChunk,
  }
}

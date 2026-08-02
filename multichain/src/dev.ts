// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * LOCAL DEV / TEST ONLY — helpers for bee-compose's chain.
 *
 * The one leg that cannot run locally is the cross-chain payment, so its funds
 * come from the faucet the bake leaves on the chain. Everything downstream —
 * the Sushi swap, approve, createBatch — is the production path against a real
 * BZZ market. Production code must never import this module.
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
 * bee-compose's dev faucet, `keccak256("bee-compose dev faucet")` — its bake
 * leaves it holding xDAI and a BZZ float precisely so dev tooling can fund an
 * address by transfer instead of trading on the real (thin) pool. A publicly
 * known development key, worthless outside that chain.
 */
export const DEV_FAUCET_PRIVATE_KEY: `0x${string}` =
  "0xc50a4bc364bb2f90007c01e3dc68c5bbc5451d4f7465510e8cffde8c137e6cf9"

/** Where the funds handed out by `fundLocalAccount` come from. */
export const DEV_FAUCET_ADDRESS: `0x${string}` = privateKeyToAccount(
  DEV_FAUCET_PRIVATE_KEY,
).address

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
 * an address — typically the derived batch-owner — from the chain's faucet.
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
        originPrivateKey: DEV_FAUCET_PRIVATE_KEY,
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
        originPrivateKey: DEV_FAUCET_PRIVATE_KEY,
        to: options.to,
      },
      settings,
      rpcProvider,
    )
    await waitForTransactionSuccess(hash, settings, rpcProvider)
  }
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

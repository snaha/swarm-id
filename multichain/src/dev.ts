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
import { createBatch, type CreateBatchResult } from "./postage-write"
import type { MultichainSettings } from "./settings"
import { approveBzz, transferBzz, transferNative } from "./tokens"
import { waitForTransactionSuccess } from "./waiter"

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
  rpcProvider: RollingValueProvider<string>,
): Promise<void> {
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
  rpcProvider: RollingValueProvider<string>,
): Promise<CreateBatchResult> {
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

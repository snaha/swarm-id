// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DEV ONLY — stands in for the production payment flow on the local chain.
 *
 * The bee-compose anvil chain has no Relay and no DEX, so money cannot arrive
 * the real way. These helpers transfer xDAI and TestToken BZZ from the queen
 * dev account instead, which lets the whole on-chain engine (approve, topUp,
 * increaseDepth, reconcile) run for real against anvil.
 */
import { createLocalBatch, fundLocalAccount } from '@swarm-id/multichain/dev'

import { GAS_BUDGET_XDAI_WEI, postageChainClient } from '$lib/payment/postage-onchain'
import { derivePostageSigner } from '$lib/payment/purchase'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

/** Default drive size for the dev "create owned batch" action. */
const DEV_BATCH_DEPTH = 20
/** Funds the dev batch well above the contract's ~24h floor. */
const DEV_BATCH_FLOOR_MULTIPLE = 3n
/** Generous gas dust so a dev address can run many operations. */
const DEV_XDAI_FUNDING = GAS_BUDGET_XDAI_WEI * 10n

function localSettings() {
  const client = postageChainClient(networkSettingsStore.gnosisRpcUrl)
  return client.settings
}

/**
 * Deliver `bzzPlur` of BZZ (and gas dust) to the account's postage-signer
 * address — the mock of the production funding leg.
 */
export async function fundPostageSigner(derivationKey: string, bzzPlur: bigint): Promise<void> {
  const { destination } = await derivePostageSigner(derivationKey)
  await fundLocalAccount(
    { to: destination as `0x${string}`, xdai: DEV_XDAI_FUNDING, bzzPlur },
    localSettings(),
  )
}

/** A batch created on the local chain, in the terms a purchase reports. */
export interface LocalBatch {
  batchId: string
  depth: number
  /** Initial balance per chunk, in PLUR. */
  amountPerChunk: bigint
  /** Block the creation landed in, as the widget reports it (hex). */
  blockNumber: string
}

/**
 * Create a batch on the local chain that the account's postage signer OWNS,
 * paid for by the queen — mirroring production, where the payment machinery
 * creates the batch and the derived signer owns it. The signer is also topped
 * up with gas, since extend and resize are signed by it rather than the payer.
 */
export async function createOwnedBatchOnChain(
  derivationKey: string,
  depth: number = DEV_BATCH_DEPTH,
): Promise<LocalBatch> {
  const { destination } = await derivePostageSigner(derivationKey)
  const settings = localSettings()
  const client = postageChainClient(networkSettingsStore.gnosisRpcUrl)
  const { minimumInitialBalancePerChunk } = await client.getPostageWriteConstraints()
  const amountPerChunk = minimumInitialBalancePerChunk * DEV_BATCH_FLOOR_MULTIPLE
  const { batchId, transactionHash } = await createLocalBatch(
    { owner: destination as `0x${string}`, depth, amountPerChunk },
    settings,
  )
  await fundLocalAccount(
    { to: destination as `0x${string}`, xdai: DEV_XDAI_FUNDING, bzzPlur: 0n },
    settings,
  )
  const receipt = await client.getTransactionReceipt(transactionHash)
  return {
    batchId,
    depth,
    amountPerChunk,
    blockNumber: receipt?.blockNumber ?? '0x0',
  }
}

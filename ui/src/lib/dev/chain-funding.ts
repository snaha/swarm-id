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

/**
 * Create a batch on the local chain that the account's postage signer OWNS,
 * paid for by the queen — mirroring production, where the payment machinery
 * creates the batch and the derived signer owns it. Returns the batch id.
 */
export async function createOwnedBatchOnChain(
  derivationKey: string,
  depth: number = DEV_BATCH_DEPTH,
): Promise<string> {
  const { destination } = await derivePostageSigner(derivationKey)
  const settings = localSettings()
  const client = postageChainClient(networkSettingsStore.gnosisRpcUrl)
  const { minimumInitialBalancePerChunk } = await client.getPostageWriteConstraints()
  const { batchId } = await createLocalBatch(
    {
      owner: destination as `0x${string}`,
      depth,
      amountPerChunk: minimumInitialBalancePerChunk * DEV_BATCH_FLOOR_MULTIPLE,
    },
    settings,
  )
  // Gas for the owner's own later operations (the batch creation was paid by
  // the queen, but extend/resize are signed by the owner).
  await fundLocalAccount(
    { to: destination as `0x${string}`, xdai: DEV_XDAI_FUNDING, bzzPlur: 0n },
    settings,
  )
  return batchId
}

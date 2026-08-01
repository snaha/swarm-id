// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DEV ONLY — stands in for the production payment flow on a local chain.
 *
 * There are two local chains, and they are not equally faithful:
 *
 * - **bee-compose anvil** (chain 4020) has no DEX, so BZZ cannot be bought.
 *   The prefunded queen account transfers xDAI and TestToken BZZ directly.
 *   Fast, offline, and enough to exercise the postage operations themselves.
 * - **a Gnosis fork** (chain 100 on localhost, `pnpm dev:fork`) carries the
 *   real PostageStamp, the real BZZ and the real SushiSwap pools. There the
 *   only thing faked is the bridge: xDAI is minted with anvil's setBalance and
 *   everything after it — swap, approve, createBatch — is the production path.
 *
 * Production code must never import this module.
 */
import { LOCAL_ANVIL_CHAIN_ID, type MultichainSettings } from '@swarm-id/multichain'
import {
  anvilSetBalance,
  createLocalBatch,
  fundLocalAccount,
  simulateWidgetPurchase,
} from '@swarm-id/multichain/dev'
import { generatePrivateKey } from 'viem/accounts'

import { GAS_BUDGET_XDAI_WEI, postageChain } from '$lib/payment/postage-onchain'
import { derivePostageSigner } from '$lib/payment/purchase'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

/** Default drive size for the dev batch actions. Small on a Gnosis chain,
 * where every chunk of depth costs real BZZ out of a thin pool. */
const DEV_BATCH_DEPTH = 20
const DEV_GNOSIS_BATCH_DEPTH = 17
/** Funds a dev batch well above the contract's ~24h floor. */
const DEV_BATCH_FLOOR_MULTIPLE = 3n
/**
 * Per-chunk funding a Bee node following a Gnosis SNAPSHOT will accept. Such a
 * node has no chain history to work from, so it synthesises a total-outpayment
 * baseline of roughly `price × block height` — around 1.14e12 per chunk at the
 * snapshot's block. A batch created now carries the contract's real
 * outpayment, which is lower, so anything funded normally is written off as a
 * `low balance batch` and ignored. Clear the baseline instead.
 */
const DEV_GNOSIS_AMOUNT_PER_CHUNK = 1_500_000_000_000n
/** Generous gas dust so a dev address can run many operations. */
const DEV_XDAI_FUNDING = GAS_BUDGET_XDAI_WEI * 10n
/** Bankrolls the fork's throwaway payer: swap input, batch cost and gas. */
const FORK_PAYER_XDAI = 5n * 10n ** 18n // 5 xDAI
/** Of that, what goes into BZZ — enough to fund a batch the node will accept,
 * still small against the pool. */
const FORK_SWAP_XDAI = 2n * 10n ** 18n

function isBeeComposeChain(settings: MultichainSettings): boolean {
  return settings.chainId === LOCAL_ANVIL_CHAIN_ID
}

/**
 * Deliver BZZ (and gas dust) to the account's postage signer — the stand-in
 * for a completed payment. On a fork the BZZ is really bought on SushiSwap.
 */
export async function fundPostageSigner(derivationKey: string, bzzPlur: bigint): Promise<void> {
  const { signerKey, destination } = await derivePostageSigner(derivationKey)
  const chain = await postageChain()
  const owner = destination as `0x${string}`

  if (isBeeComposeChain(chain.settings)) {
    await fundLocalAccount({ to: owner, xdai: DEV_XDAI_FUNDING, bzzPlur }, chain.settings)
    return
  }

  // Fork: mint the gas, then buy the BZZ for real with the owner's own key.
  await anvilSetBalance(networkSettingsStore.gnosisRpcUrl, owner, FORK_PAYER_XDAI)
  if (bzzPlur > 0n) {
    const hash = await chain.swapXdaiToBzz({
      originPrivateKey: `0x${signerKey.toHex()}`,
      amountXdai: FORK_SWAP_XDAI,
      recipient: owner,
    })
    await chain.waitForTransactionSuccess(hash)
  }
}

/** A batch created on a local chain, in the terms a purchase reports. */
export interface LocalBatch {
  batchId: string
  depth: number
  /** Initial balance per chunk, in PLUR. */
  amountPerChunk: bigint
  /** Block the creation landed in, as the widget reports it (hex). */
  blockNumber: string
}

/**
 * Create a batch the account's postage signer OWNS, paid for by someone else —
 * the production role split, where the payment machinery creates the batch and
 * the derived signer owns it.
 *
 * On a fork this runs the widget's actual step list (swap → approve →
 * createBatch → hand over the leftovers); on bee-compose the queen simply pays.
 */
export async function createOwnedBatchOnChain(
  derivationKey: string,
  requestedDepth?: number,
): Promise<LocalBatch> {
  const { destination } = await derivePostageSigner(derivationKey)
  const chain = await postageChain()
  const owner = destination as `0x${string}`
  const depth =
    requestedDepth ?? (isBeeComposeChain(chain.settings) ? DEV_BATCH_DEPTH : DEV_GNOSIS_BATCH_DEPTH)
  const { minimumInitialBalancePerChunk } = await chain.getPostageWriteConstraints()
  const onBeeCompose = isBeeComposeChain(chain.settings)
  const amountPerChunk = onBeeCompose
    ? minimumInitialBalancePerChunk * DEV_BATCH_FLOOR_MULTIPLE
    : DEV_GNOSIS_AMOUNT_PER_CHUNK

  const created = onBeeCompose
    ? await createLocalBatch({ owner, depth, amountPerChunk }, chain.settings)
    : await simulateWidgetPurchase(
        {
          owner,
          depth,
          amountPerChunk,
          payerPrivateKey: generatePrivateKey(),
          payerXdai: FORK_PAYER_XDAI,
          swapXdai: FORK_SWAP_XDAI,
        },
        chain.settings,
      )

  if (isBeeComposeChain(chain.settings)) {
    // Gas for the owner's own later operations; the fork's payer already
    // handed its leftovers over.
    await fundLocalAccount({ to: owner, xdai: DEV_XDAI_FUNDING, bzzPlur: 0n }, chain.settings)
  }

  const receipt = await chain.getTransactionReceipt(created.transactionHash)
  return {
    batchId: created.batchId,
    depth,
    amountPerChunk,
    blockNumber: receipt?.blockNumber ?? '0x0',
  }
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DEV ONLY — stands in for the production payment flow on a local chain.
 *
 * There are two local chains, and they are not equally faithful:
 *
 * - **the baked chain answering as Gnosis (100)** — bee-compose's cluster
 *   (`pnpm dev:bee`) or the same snapshot standalone (`pnpm dev:chain`) —
 *   carries a real BZZ market and the PostageStamp the nodes follow. There the
 *   only thing faked is the bridge: xDAI is minted with anvil's setBalance and
 *   everything after it — swap, approve, createBatch — is the production path.
 * - **a DEX-less anvil** (chain 4020) has no BZZ market, so the prefunded
 *   queen account transfers xDAI and TestToken BZZ directly instead. Enough to
 *   exercise the postage operations themselves, nothing about the purchase.
 *
 * Both prefund an account the tooling can draw on, so handing an address what
 * it needs is a transfer rather than a trade — the BZZ pool is real and thin,
 * and only the purchase itself is worth spending it on.
 *
 * Production code must never import this module.
 */
import { LOCAL_ANVIL_CHAIN_ID, type MultichainSettings } from '@swarm-id/multichain'
import {
  createLocalBatch,
  fundLocalAccount,
  simulateWidgetPurchase,
} from '@swarm-id/multichain/dev'
import { generatePrivateKey } from 'viem/accounts'

import { GAS_BUDGET_XDAI_WEI, postageChain } from '$lib/payment/postage-onchain'
import { derivePostageSigner } from '$lib/payment/purchase'

/** Default drive size for the dev batch actions. */
const DEV_BATCH_DEPTH = 20
/** Funds a dev batch well above the contract's ~24h floor. */
const DEV_BATCH_FLOOR_MULTIPLE = 3n
/** Generous gas dust so a dev address can run many operations. */
const DEV_XDAI_FUNDING = GAS_BUDGET_XDAI_WEI * 10n
/**
 * Headroom on a requested amount. A funding need is computed from a chain read
 * that is a block or two old by the time the operation spends it; a real
 * payment over-delivers too (the widget swaps a quoted amount with slippage),
 * and out of a faucet the margin is free.
 */
const FUNDING_MARGIN = 2n
/** Bankrolls the simulated purchase's throwaway payer: swap, batch and gas. */
const PURCHASE_PAYER_XDAI = 2n * 10n ** 18n // 2 xDAI
/**
 * Of that, what goes into BZZ. Two orders of magnitude more than a dev batch
 * costs, so price drift on a long-lived chain cannot starve a purchase, and
 * still small against a ~$10k pool. The leftovers go to the batch owner, as
 * they do in production.
 */
const PURCHASE_SWAP_XDAI = 10n ** 18n / 4n // 0.25 xDAI

function isBeeComposeChain(settings: MultichainSettings): boolean {
  return settings.chainId === LOCAL_ANVIL_CHAIN_ID
}

/**
 * Deliver BZZ (and gas dust) to the account's postage signer — the stand-in
 * for a completed payment.
 *
 * A transfer from the chain's faucet, not a swap: every swap moves a real and
 * thin BZZ pool, and topping a signer up is not the thing worth simulating
 * faithfully. The purchase path still trades — see `createOwnedBatchOnChain`.
 */
export async function fundPostageSigner(derivationKey: string, bzzPlur: bigint): Promise<void> {
  const { destination } = await derivePostageSigner(derivationKey)
  const chain = await postageChain()
  await fundLocalAccount(
    { to: destination as `0x${string}`, xdai: DEV_XDAI_FUNDING, bzzPlur: bzzPlur * FUNDING_MARGIN },
    chain.settings,
  )
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
 * On a chain with a BZZ market this runs the widget's actual step list (swap →
 * approve → createBatch → hand over the leftovers); on a DEX-less anvil the
 * queen simply pays.
 */
export async function createOwnedBatchOnChain(
  derivationKey: string,
  requestedDepth?: number,
): Promise<LocalBatch> {
  const { destination } = await derivePostageSigner(derivationKey)
  const chain = await postageChain()
  const owner = destination as `0x${string}`
  const depth = requestedDepth ?? DEV_BATCH_DEPTH
  const { minimumInitialBalancePerChunk } = await chain.getPostageWriteConstraints()
  const onBeeCompose = isBeeComposeChain(chain.settings)
  const amountPerChunk = minimumInitialBalancePerChunk * DEV_BATCH_FLOOR_MULTIPLE

  const created = onBeeCompose
    ? await createLocalBatch({ owner, depth, amountPerChunk }, chain.settings)
    : await simulateWidgetPurchase(
        {
          owner,
          depth,
          amountPerChunk,
          payerPrivateKey: generatePrivateKey(),
          payerXdai: PURCHASE_PAYER_XDAI,
          swapXdai: PURCHASE_SWAP_XDAI,
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

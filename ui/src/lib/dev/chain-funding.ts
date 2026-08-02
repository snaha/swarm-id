// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DEV ONLY — stands in for the production payment flow on the local chain.
 *
 * That chain — bee-compose's cluster (`pnpm dev:bee`) or the same snapshot
 * standalone (`pnpm dev:chain`) — carries a real BZZ market and the
 * PostageStamp the nodes follow, so the only faked leg is the bridge: xDAI is
 * minted with anvil's setBalance and everything after it (swap, approve,
 * createBatch) is the production path.
 *
 * It also prefunds a faucet, so handing an address what it needs is a transfer
 * rather than a trade — the BZZ pool is real and thin, and only the purchase
 * itself is worth spending it on.
 *
 * Production code must never import this module.
 */
import {
  DEV_FAUCET_ADDRESS,
  fundLocalAccount,
  simulateWidgetPurchase,
} from '@swarm-id/multichain/dev'
import { generatePrivateKey } from 'viem/accounts'

import { GAS_BUDGET_XDAI_WEI, ownerFunds, postageChain } from '$lib/payment/postage-onchain'
import { derivePostageSigner } from '$lib/payment/purchase'

/** Default drive size for the dev batch actions. */
const DEV_BATCH_DEPTH = 20
/** Funds a dev batch well above the contract's ~24h floor. */
const DEV_BATCH_FLOOR_MULTIPLE = 3n
/** Generous gas dust so a dev address can run many operations. */
export const DEV_XDAI_FUNDING = GAS_BUDGET_XDAI_WEI * 10n
/** Bankrolls the simulated purchase's throwaway payer: swap, batch and gas. */
const PURCHASE_PAYER_XDAI = 2n * 10n ** 18n // 2 xDAI
/**
 * Of that, what goes into BZZ. Two orders of magnitude more than a dev batch
 * costs, so price drift on a long-lived chain cannot starve a purchase, and
 * still small against a ~$10k pool. The leftovers go to the batch owner, as
 * they do in production.
 */
const PURCHASE_SWAP_XDAI = 10n ** 18n / 4n // 0.25 xDAI

/**
 * Deliver xDAI and BZZ to the account's postage signer — the stand-in for a
 * completed payment.
 *
 * A transfer from the chain's faucet, not a swap: every swap moves a real and
 * thin BZZ pool, and topping a signer up is not the thing worth simulating
 * faithfully. The purchase path still trades — see `createOwnedBatchOnChain`.
 */
export async function fundPostageSigner(
  derivationKey: string,
  amounts: { xdai: bigint; bzzPlur: bigint },
): Promise<void> {
  const { destination } = await derivePostageSigner(derivationKey)
  const chain = await postageChain()
  await fundLocalAccount({ to: destination as `0x${string}`, ...amounts }, chain.settings)
}

/** An address and what it currently holds, for the faucet panel. */
export interface FundsRow {
  address: `0x${string}`
  xdai: bigint
  bzz: bigint
}

/**
 * What the faucet has left to give, and what the selected account's signer
 * holds — the two numbers that decide whether a dev action can run at all.
 */
export async function devChainFunds(
  derivationKey: string,
): Promise<{ faucet: FundsRow; signer: FundsRow }> {
  const chain = await postageChain()
  const { destination } = await derivePostageSigner(derivationKey)
  const faucet = DEV_FAUCET_ADDRESS
  const signer = destination as `0x${string}`
  const [faucetFunds, signerFunds] = await Promise.all([
    ownerFunds(faucet, chain),
    ownerFunds(signer, chain),
  ])
  return {
    faucet: { address: faucet, ...faucetFunds },
    signer: { address: signer, ...signerFunds },
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
 * Runs the widget's actual step list: swap → approve → createBatch → hand the
 * leftovers to the owner.
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
  const amountPerChunk = minimumInitialBalancePerChunk * DEV_BATCH_FLOOR_MULTIPLE

  const created = await simulateWidgetPurchase(
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

  const receipt = await chain.getTransactionReceipt(created.transactionHash)
  return {
    batchId: created.batchId,
    depth,
    amountPerChunk,
    blockNumber: receipt?.blockNumber ?? '0x0',
  }
}

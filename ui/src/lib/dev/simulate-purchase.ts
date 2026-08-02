// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DEV ONLY — local stand-in for the multichain purchase widget.
 *
 * The widget pays cross-chain and creates the postage batch on Gnosis. Neither
 * leg exists locally, but the batch creation does: on the bee-compose chain we
 * create a REAL batch owned by the account's postage signer (the queen account
 * plays the widget's temp wallet, which is exactly the production role split).
 *
 * That matters beyond the purchase itself — a drive bought this way is backed
 * by a batch the chain knows, so extend and resize work on it afterwards. A
 * fabricated batch id would leave those flows with nothing to read.
 *
 * Without a reachable local chain there is nothing to create against, so the
 * simulation falls back to a fabricated settlement: the add-drive flow still
 * exercises end to end (as the drive e2e suite needs), the resulting drive is
 * simply not on any chain.
 */
import { createOwnedBatchOnChain } from '$lib/dev/chain-funding'
import type { BatchEvent } from '$lib/payment/multichain-widget'
import { chainIdentity } from '$lib/payment/postage-onchain'

const BATCH_ID_HEX_LENGTH = 64
const FABRICATED_DEPTH = 20
const FABRICATED_AMOUNT = '10000000000'
const MS_PER_SECOND = 1000
const HEX_RADIX = 16

/** A settlement with no chain behind it — shape-accurate, batch fictional. */
function fabricatedBatch(): BatchEvent {
  const batchId = (crypto.randomUUID() + crypto.randomUUID())
    .replace(/-/g, '')
    .slice(0, BATCH_ID_HEX_LENGTH)
  return {
    event: 'batch',
    batchId,
    depth: FABRICATED_DEPTH,
    amount: FABRICATED_AMOUNT,
    blockNumber: '0x' + Math.floor(Date.now() / MS_PER_SECOND).toString(HEX_RADIX),
  }
}

/**
 * Settle a simulated purchase, creating a REAL batch when the configured RPC is
 * a dev chain — where the widget's whole step list runs against contracts that
 * behave like the real ones. Real Gnosis is excluded by genesis hash, not by a
 * hostname guess: no dev toggle may reach mainnet, and a dev chain reports the
 * same chain id on purpose.
 */
export async function simulateBatchPurchase(derivationKey: string): Promise<BatchEvent> {
  const identity = await chainIdentity().catch(() => undefined)
  if (!identity || identity.isMainnet) {
    return fabricatedBatch()
  }
  try {
    const batch = await createOwnedBatchOnChain(derivationKey)
    return {
      event: 'batch',
      batchId: batch.batchId,
      depth: batch.depth,
      amount: batch.amountPerChunk.toString(),
      blockNumber: batch.blockNumber,
    }
  } catch {
    // No chain reachable (or it refused) — keep the flow exercisable.
    return fabricatedBatch()
  }
}

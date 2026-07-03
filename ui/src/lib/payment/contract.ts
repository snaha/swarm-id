// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import {
  calculateContractTTLSeconds,
  fetchOnChainBatchState,
  resolvePostageStampContractAddress,
} from '@snaha/swarm-id'

import { strip0x } from '$lib/crypto/hex'
import type { NewStamp } from '$lib/payment/purchase'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

// bee-compose anvil deploy of the PostageStamp contract; only used when the RPC
// URL is local (resolvePostageStampContractAddress gates it — a remote RPC
// resolves to Gnosis mainnet). Inert in production.
export const LOCAL_POSTAGE_STAMP_CONTRACT_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512'

/**
 * Read a batch's parameters straight from the PostageStamp contract ON-CHAIN
 * (not from a Bee node), so any batch id works even when the configured node
 * never saw it — e.g. a public gateway with no `/stamps`, or a batch bought
 * independently. The signer key is NOT on-chain, so the caller supplies it (it's
 * needed to sign uploads with the batch and is validated later by an upload probe).
 *
 * Returns `undefined` when the batch isn't found on chain — which the lib's
 * `fetchOnChainBatchState` also collapses "couldn't read the chain" into.
 */
export async function fetchExistingBatchFromChain(
  batchId: string,
  signerKey: PrivateKey,
  // Optional: an unnamed drive falls back to a batch-ID-derived label (drives.ts).
  name: string | undefined,
  opts?: { rpcUrl?: string; contractAddress?: string },
): Promise<NewStamp | undefined> {
  const rpcUrl = opts?.rpcUrl ?? networkSettingsStore.gnosisRpcUrl
  const contractAddress =
    opts?.contractAddress ??
    resolvePostageStampContractAddress(rpcUrl, LOCAL_POSTAGE_STAMP_CONTRACT_ADDRESS)

  const state = await fetchOnChainBatchState(rpcUrl, strip0x(batchId), contractAddress)
  if (!state) {
    return undefined
  }

  const { batch } = state
  const ttl = calculateContractTTLSeconds(state)
  return {
    batchID: new BatchId(strip0x(batchId)),
    name,
    signerKey,
    depth: batch.depth,
    bucketDepth: batch.bucketDepth,
    // Remaining per-chunk balance: `normalisedBalance` is the run-out watermark
    // (cumulative outpayment since genesis), so subtract the global outpayment to
    // get what dilute/extend read as `stamp.amount`. The original purchase amount
    // isn't recoverable on-chain.
    amount: batch.normalisedBalance - state.currentTotalOutPayment,
    blockNumber: Number(batch.lastUpdatedBlockNumber),
    immutableFlag: batch.immutableFlag,
    // On-chain has no per-bucket usage; the local stamper tracks it from here.
    utilization: 0,
    usable: ttl === undefined || ttl > 0,
    exists: true,
    batchTTL: ttl,
  }
}

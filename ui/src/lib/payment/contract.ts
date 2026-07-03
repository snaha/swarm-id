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
const LOCAL_POSTAGE_STAMP_CONTRACT_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512'

/**
 * Result of looking a batch up on the PostageStamp contract. `not-found` covers
 * both "no such batch on this chain" and "couldn't read the chain" — the lib's
 * `fetchOnChainBatchState` collapses those into one `undefined`.
 */
export type ExistingBatchLookup = { status: 'found'; stamp: NewStamp } | { status: 'not-found' }

/**
 * Read a batch's parameters straight from the PostageStamp contract ON-CHAIN
 * (not from a Bee node), so any batch id works even when the configured node
 * never saw it — e.g. a public gateway with no `/stamps`, or a batch bought
 * independently. The signer key is NOT on-chain, so the caller supplies it (it's
 * needed to sign uploads with the batch and is validated later by an upload probe).
 */
export async function fetchExistingBatchFromChain(
  batchId: string,
  signerKey: PrivateKey,
  // Optional: an unnamed drive falls back to a batch-ID-derived label (drives.ts).
  name: string | undefined,
  opts?: { rpcUrl?: string; contractAddress?: string },
): Promise<ExistingBatchLookup> {
  const rpcUrl = opts?.rpcUrl ?? networkSettingsStore.gnosisRpcUrl
  const contractAddress =
    opts?.contractAddress ??
    resolvePostageStampContractAddress(rpcUrl, LOCAL_POSTAGE_STAMP_CONTRACT_ADDRESS)

  const state = await fetchOnChainBatchState(rpcUrl, strip0x(batchId), contractAddress)
  if (!state) {
    return { status: 'not-found' }
  }

  const { batch } = state
  const ttl = calculateContractTTLSeconds(state)
  return {
    status: 'found',
    stamp: {
      batchID: new BatchId(strip0x(batchId)),
      name,
      signerKey,
      depth: batch.depth,
      bucketDepth: batch.bucketDepth,
      // On-chain per-chunk balance level (record metadata only — the stamper
      // doesn't read it); the original purchase amount isn't recoverable on-chain.
      amount: batch.normalisedBalance,
      blockNumber: Number(batch.lastUpdatedBlockNumber),
      immutableFlag: batch.immutableFlag,
      // On-chain has no per-bucket usage; the local stamper tracks it from here.
      utilization: 0,
      usable: ttl === undefined || ttl > 0,
      exists: true,
      batchTTL: ttl,
    },
  }
}

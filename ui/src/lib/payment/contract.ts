// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId, PrivateKey } from '@ethersphere/bee-js'
import { calculateContractTTLSeconds, fetchOnChainBatchStateResult } from '@snaha/swarm-id'

import { strip0x } from '$lib/crypto/hex'
import { postageChain } from '$lib/payment/chain'
import type { NewStamp } from '$lib/payment/purchase'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

/**
 * Read a batch's parameters straight from the PostageStamp contract ON-CHAIN
 * (not from a Bee node), so any batch id works even when the configured node
 * never saw it — e.g. a public gateway with no `/stamps`, or a batch bought
 * independently. The signer key is NOT on-chain, so the caller supplies it (it's
 * needed to sign uploads with the batch and is validated later by an upload probe).
 *
 * Returns `undefined` ONLY when the contract authoritatively has no such batch.
 * An endpoint that could not be read throws instead: "we couldn't ask" and
 * "it isn't there" send the user to different places, and the callers here
 * render the `undefined` as advice to check the batch id.
 */
export async function fetchExistingBatchFromChain(
  batchId: string,
  signerKey: PrivateKey,
  // Optional: an unnamed drive falls back to a batch-ID-derived label (drives.ts).
  name: string | undefined,
  opts?: { rpcUrl?: string; contractAddress?: string },
): Promise<NewStamp | undefined> {
  const rpcUrl = opts?.rpcUrl ?? networkSettingsStore.gnosisRpcUrl
  // Every chain this app talks to is Gnosis or a fork of it carrying the
  // deployment at the same address, so the address itself is a constant. Going
  // through the chain for it makes the endpoint prove which chain it serves —
  // but only on first contact: the answer is cached, so a session that starts
  // healthy and loses the endpoint later passes this gate anyway. The read
  // below is what catches that, which is why it must not collapse a failed
  // request into "not found".
  const contractAddress =
    opts?.contractAddress ?? (await postageChain(rpcUrl)).settings.addresses.postageStamp

  const result = await fetchOnChainBatchStateResult(rpcUrl, strip0x(batchId), contractAddress)
  if (result.status === 'error') {
    throw new Error(
      'Could not read the batch from the configured Gnosis RPC — the endpoint did not answer.',
    )
  }
  if (result.status === 'not-found') {
    return undefined
  }

  const state = result.state
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

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { postageChain } from '$lib/payment/postage-onchain'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

/** How long a fetched chain price stays fresh. The oracle price moves slowly;
 * a short cache stops every dialog open from re-hitting the RPC. */
const PRICE_TTL_MS = 60_000

let cached: { price: bigint; fetchedAt: number; url: string } | undefined

/**
 * The chain's current storage price (PLUR per chunk per block), read from the
 * PostageStamp contract itself — no Bee node involved — cached briefly and
 * shared by the drive dialogs. Rejects when the RPC is unreachable — callers
 * surface that and may simply call again to retry (a failure is never cached).
 */
export async function currentChainPrice(): Promise<bigint> {
  const url = networkSettingsStore.gnosisRpcUrl
  if (cached && cached.url === url && Date.now() - cached.fetchedAt < PRICE_TTL_MS) {
    return cached.price
  }
  const { lastPrice } = await (await postageChain(url)).getPostageWriteConstraints()
  cached = { price: lastPrice, fetchedAt: Date.now(), url }
  return lastPrice
}

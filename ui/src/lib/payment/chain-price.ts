// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { fetchChainState } from '@snaha/swarm-id'

import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

/** How long a fetched chain price stays fresh. The oracle price moves slowly;
 * a short cache stops every dialog open from re-hitting the node. */
const PRICE_TTL_MS = 60_000

let cached: { price: bigint; fetchedAt: number; url: string } | undefined

/**
 * The chain's current storage price (PLUR per chunk per block) from the
 * configured Bee node, cached briefly and shared by the drive dialogs.
 * Rejects when the node is unreachable — callers surface that and may simply
 * call again to retry (a failure is never cached).
 */
export async function currentChainPrice(): Promise<bigint> {
  const url = networkSettingsStore.beeNodeUrl
  if (cached && cached.url === url && Date.now() - cached.fetchedAt < PRICE_TTL_MS) {
    return cached.price
  }
  const state = await fetchChainState(url)
  cached = { price: state.currentPrice, fetchedAt: Date.now(), url }
  return state.currentPrice
}

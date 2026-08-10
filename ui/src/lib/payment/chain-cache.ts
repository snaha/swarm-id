// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Caching a chain read per RPC endpoint, for the dialogs' live figures.
 *
 * The drive dialogs re-derive their estimates on every keystroke, so the reads
 * behind them (the storage price, the BZZ rate) cannot be a round-trip each —
 * but they also cannot be cached forever, and they must not survive a change of
 * endpoint, since a figure from mainnet shown against a local chain is worse
 * than no figure at all. Keying on the URL is what makes switching networks in
 * Network settings take effect without a reload.
 */
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

/**
 * Wrap `read` so it runs at most once per `ttlMs` per configured Gnosis RPC.
 *
 * A rejection is never cached — the node may just have been starting up — so
 * the next dialog open retries rather than showing a permanent dash.
 */
export function cachedChainRead<T>(
  ttlMs: number,
  read: (rpcUrl: string) => Promise<T>,
): () => Promise<T> {
  let cached: { value: T; fetchedAt: number; url: string } | undefined
  return async () => {
    const url = networkSettingsStore.gnosisRpcUrl
    if (cached && cached.url === url && Date.now() - cached.fetchedAt < ttlMs) {
      return cached.value
    }
    const value = await read(url)
    cached = { value, fetchedAt: Date.now(), url }
    return value
  }
}

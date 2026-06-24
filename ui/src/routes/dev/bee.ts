// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Raw Bee-node operations used only by the developer tools (`/dev`). These talk
 * to a local Bee node directly rather than through the proxy, so they live
 * outside the account store — they read and mutate node state, not account
 * state. The page records the resulting stamps on the account via
 * `accountsStore`.
 */

/** A postage batch as returned by Bee's `GET /stamps`. */
export interface BeeStamp {
  batchID: string
  utilization: number
  usable: boolean
  label: string
  depth: number
  amount: string
  bucketDepth: number
  blockNumber: number
  immutableFlag: boolean
  exists: boolean
  batchTTL: number
}

export interface BoughtStamp {
  batchID: string
  txHash: string
}

/** How a `checkEndpoint` probe is performed for a given service. */
export type EndpointProbe = 'head' | 'json-rpc'

async function readError(response: Response): Promise<string> {
  const text = await response.text()
  return text || `HTTP ${response.status}`
}

export const beeDev = {
  /**
   * Liveness probe for a local service. HTTP services answer a no-cors HEAD
   * (opaque but resolves when reachable); the JSON-RPC node answers an
   * `eth_blockNumber` call. Returns whether the endpoint responded.
   */
  async checkEndpoint(endpoint: string, probe: EndpointProbe = 'head'): Promise<boolean> {
    try {
      if (probe === 'json-rpc') {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
        })
        return response.ok
      }
      await fetch(endpoint, { method: 'HEAD', mode: 'no-cors' })
      return true
    } catch {
      return false
    }
  },

  /** List the postage batches the Bee node knows about. */
  async fetchStamps(beeUrl: string): Promise<BeeStamp[]> {
    const response = await fetch(`${beeUrl}/stamps`)
    if (!response.ok) {
      throw new Error(await readError(response))
    }
    const data = (await response.json()) as { stamps?: BeeStamp[] }
    return data.stamps ?? []
  },

  /**
   * Buy a MUTABLE postage batch on the local chain. Bee defaults to immutable,
   * but the multi-device partition scheme rewrites the partition-lock SOC on
   * every lease refresh, which an immutable batch forbids — so request mutable
   * explicitly. Returns immediately (no wait-for-usable); the batch needs ~30s
   * before it can stamp uploads.
   */
  async buyStamp(beeUrl: string, amount: string, depth: string): Promise<BoughtStamp> {
    const response = await fetch(`${beeUrl}/stamps/${amount}/${depth}`, {
      method: 'POST',
      headers: { immutable: 'false' },
    })
    if (!response.ok) {
      throw new Error(await readError(response))
    }
    return (await response.json()) as BoughtStamp
  },
}

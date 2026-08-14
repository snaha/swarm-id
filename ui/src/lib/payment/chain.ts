// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Which chain is on the other end of the configured Gnosis RPC, and a client
 * for it.
 *
 * Separate from the operations built on top because the question is asked well
 * before any of them: the dev tools, the network settings dialog and the
 * postage engine all need to know whether they are talking to Gnosis mainnet
 * or to a local chain wearing its chain id, and the answer decides which
 * contract addresses and which RPC fallbacks apply.
 */
import {
  GNOSIS_CHAIN_ID,
  MultichainClient,
  type MultichainSettings,
  gnosisMainnetSettings,
} from '@swarm-id/multichain'

import { prefix0x } from '$lib/crypto/hex'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

/**
 * Settings for the endpoint. There is one preset: the baked local chain carries
 * a real BZZ market and the contracts at their mainnet addresses, so it is
 * driven with the production ones — which is what makes it worth testing on.
 */
function settingsFor(identity: ChainIdentity, rpcUrl: string): MultichainSettings {
  if (identity.chainId !== GNOSIS_CHAIN_ID) {
    throw new Error(
      `The configured Gnosis RPC reports chain id ${identity.chainId}, not Gnosis (${GNOSIS_CHAIN_ID}). Check the network settings.`,
    )
  }
  // A dev chain answering as Gnosis must never fall back to the public RPCs:
  // a failed call would silently read REAL mainnet state.
  const mainnet = gnosisMainnetSettings()
  return gnosisMainnetSettings({
    rpcUrls: identity.isMainnet
      ? [rpcUrl, ...mainnet.rpcUrls.filter((url) => url !== rpcUrl)]
      : [rpcUrl],
  })
}

const CHAIN_ID_PROBE_TIMEOUT_MS = 5000

/**
 * Gnosis mainnet's genesis block hash. A chain's genesis is its identity and
 * cannot change, which is what makes this the honest way to ask "is this the
 * real thing" — the local chain answers chain id 100 too, deliberately, so an
 * app resolving contract addresses by chain id finds what it expects there.
 */
const GNOSIS_GENESIS_HASH = '0x4f1dd23188aab3a76b463e4af801b52b1248ef073c648cbdc4c9333d3da79756'

export interface ChainIdentity {
  chainId: number
  /**
   * True only for Gnosis mainnet itself. Anything else answering as chain 100
   * is a dev chain, and spending on it is free.
   */
  isMainnet: boolean
}

/** One JSON-RPC call without a client — none can be built until we know the chain. */
export async function probeChainId(rpcUrl: string): Promise<number> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(CHAIN_ID_PROBE_TIMEOUT_MS),
  })
  const data = (await response.json()) as { result?: string }
  if (typeof data.result !== 'string') {
    throw new Error('The configured Gnosis RPC did not report a chain id.')
  }
  return Number(BigInt(data.result))
}

/** The hash of block 0, or undefined when the endpoint keeps no genesis. */
async function probeGenesisHash(rpcUrl: string): Promise<string | undefined> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBlockByNumber',
      params: ['0x0', false],
    }),
    signal: AbortSignal.timeout(CHAIN_ID_PROBE_TIMEOUT_MS),
  })
  const data = (await response.json()) as { result?: { hash?: string } }
  return data.result?.hash
}

// One identity per RPC URL: the chain a URL serves does not change under us,
// so the probe is paid once. A failure is never cached — the node may just
// have been starting up.
const identities = new Map<string, Promise<ChainIdentity>>()
const clients = new Map<string, Promise<MultichainClient>>()

/**
 * What chain is actually on the other end of `rpcUrl`.
 *
 * The chain id alone cannot answer this: the local chain deliberately reports
 * 100 so that an app resolving contract addresses by chain id finds the Gnosis
 * deployments there. Genesis can — it is the one thing a chain cannot borrow.
 */
export function chainIdentity(
  rpcUrl: string = networkSettingsStore.gnosisRpcUrl,
): Promise<ChainIdentity> {
  const existing = identities.get(rpcUrl)
  if (existing) {
    return existing
  }
  const identity = Promise.all([probeChainId(rpcUrl), probeGenesisHash(rpcUrl)])
    .then(([chainId, genesisHash]) => ({
      chainId,
      isMainnet: chainId === GNOSIS_CHAIN_ID && genesisHash === GNOSIS_GENESIS_HASH,
    }))
    .catch((error: unknown) => {
      identities.delete(rpcUrl)
      throw error
    })
  identities.set(rpcUrl, identity)
  return identity
}

/**
 * The chain client for the configured Gnosis RPC, built from whichever preset
 * the endpoint's chain id calls for.
 * @throws when the endpoint is unreachable or serves an unsupported chain —
 *   deliberately, since every caller goes on to sign or spend.
 */
export function postageChain(
  rpcUrl: string = networkSettingsStore.gnosisRpcUrl,
): Promise<MultichainClient> {
  const existing = clients.get(rpcUrl)
  if (existing) {
    return existing
  }
  const client = chainIdentity(rpcUrl)
    .then((identity) => new MultichainClient(settingsFor(identity, rpcUrl)))
    .catch((error: unknown) => {
      clients.delete(rpcUrl)
      throw error
    })
  clients.set(rpcUrl, client)
  return client
}

export interface OwnerFunds {
  xdai: bigint
  bzz: bigint
}

/** Current balances at the batch-owner address. */
export async function ownerFunds(address: string, client?: MultichainClient): Promise<OwnerFunds> {
  const chain = client ?? (await postageChain())
  const owner = prefix0x(address) as `0x${string}`
  const [xdai, bzz] = await Promise.all([chain.getNativeBalance(owner), chain.getBzzBalance(owner)])
  return { xdai, bzz }
}

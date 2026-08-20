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
  if (identity.kind === 'unsupported') {
    throw new Error(
      `The configured Gnosis RPC reports chain id ${identity.chainId}, not Gnosis (${GNOSIS_CHAIN_ID}). Check the network settings.`,
    )
  }
  // A dev chain answering as Gnosis must never fall back to the public RPCs:
  // a failed call would silently read REAL mainnet state.
  const mainnet = gnosisMainnetSettings()
  return gnosisMainnetSettings({
    rpcUrls:
      identity.kind === 'mainnet'
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

/**
 * Three answers, not two. `dev` is the one that tells a page spending is free,
 * so it has to be *proven* — chain id 100 with a genesis that is not mainnet's
 * — rather than inferred from "not mainnet". A reachable chain that is neither
 * is `unsupported`: pointed at Ethereum, a boolean would have called it a dev
 * chain and invited the faucet to spend there.
 */
export type ChainKind = 'mainnet' | 'dev' | 'unsupported'

export interface ChainIdentity {
  chainId: number
  kind: ChainKind
}

function kindOf(chainId: number, genesisHash: string): ChainKind {
  if (chainId !== GNOSIS_CHAIN_ID) {
    return 'unsupported'
  }
  return genesisHash === GNOSIS_GENESIS_HASH ? 'mainnet' : 'dev'
}

interface JsonRpcResponse<T> {
  /**
   * `null`, not a missing field, is how JSON-RPC says "no such thing" — a node
   * that has pruned block 0 answers `result: null` rather than omitting it. It
   * is typed here so the guard below has to reject it; without that, `null`
   * flowed out as an answer and the caller crashed reading a field off it,
   * losing the crafted "could not prove it" error this module is built on.
   */
  result?: T | null
  error?: { code?: number; message?: string }
}

/**
 * One JSON-RPC call, checked. An endpoint that answers 429, or 200 carrying a
 * JSON-RPC error, must not be read as an answer: every caller of this module
 * decides from it whether money is real.
 */
async function jsonRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(CHAIN_ID_PROBE_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`The configured Gnosis RPC answered ${response.status} to ${method}.`)
  }
  const data = (await response.json()) as JsonRpcResponse<T>
  if (data.error) {
    throw new Error(
      `The configured Gnosis RPC refused ${method}: ${data.error.message ?? 'unknown error'}`,
    )
  }
  if (data.result === undefined || data.result === null) {
    throw new Error(`The configured Gnosis RPC returned no result for ${method}.`)
  }
  return data.result
}

/** One JSON-RPC call without a client — none can be built until we know the chain. */
export async function probeChainId(rpcUrl: string): Promise<number> {
  const result = await jsonRpc<string>(rpcUrl, 'eth_chainId', [])
  if (typeof result !== 'string') {
    throw new Error('The configured Gnosis RPC did not report a chain id.')
  }
  return Number(BigInt(result))
}

/**
 * The hash of block 0.
 *
 * @throws when the endpoint will not serve it. Deliberately: an unproven
 *   genesis must never resolve to "not mainnet", because that is the answer
 *   that tells the page spending is free. A rate-limited or pruned Gnosis node
 *   would otherwise be dressed up as a dev chain, under a banner saying nothing
 *   here is real, while the faucet spent actual funds. Unreachable is loud; a
 *   false all-clear is not.
 */
async function probeGenesisHash(rpcUrl: string): Promise<string> {
  const block = await jsonRpc<{ hash?: string }>(rpcUrl, 'eth_getBlockByNumber', ['0x0', false])
  if (typeof block.hash !== 'string') {
    throw new Error('The configured Gnosis RPC did not report a genesis block.')
  }
  return block.hash
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
  const identity: Promise<ChainIdentity> = Promise.all([
    probeChainId(rpcUrl),
    probeGenesisHash(rpcUrl),
  ])
    .then(([chainId, genesisHash]) => ({
      chainId,
      kind: kindOf(chainId, genesisHash),
    }))
    .catch((error: unknown) => {
      // Only evict OUR entry: a retry may already have stored a healthy probe
      // under this url, and dropping that one would re-probe for nothing.
      if (identities.get(rpcUrl) === identity) {
        identities.delete(rpcUrl)
      }
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
  const client: Promise<MultichainClient> = chainIdentity(rpcUrl)
    .then((identity) => new MultichainClient(settingsFor(identity, rpcUrl)))
    .catch((error: unknown) => {
      // Only evict OUR entry, as above: a retry may already have stored a
      // working client under this url.
      if (clients.get(rpcUrl) === client) {
        clients.delete(rpcUrl)
      }
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

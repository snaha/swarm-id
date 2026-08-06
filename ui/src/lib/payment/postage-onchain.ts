// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * On-chain postage engine: extend (topUp) and resize (increaseDepth) executed
 * directly against the PostageStamp contract on Gnosis, signed by the derived
 * batch-owner key — no Bee node involved. Thin orchestration over
 * `@swarm-id/multichain`; see docs/Postage-On-Chain-Engine.md.
 *
 * On-chain rules this module encodes (verified contract semantics):
 * - `topUp` is permissionless but pulls `amountPerChunk << depth` BZZ from the
 *   sender via `transferFrom` — an exact-amount `approve` must precede it.
 * - `increaseDepth` is owner-only and checks the post-dilution per-chunk
 *   balance against `minimumInitialBalancePerChunk` BEFORE any compensation —
 *   so the compensating top-up must run FIRST (see `resizePlan`).
 */
import type { PrivateKey } from '@ethersphere/bee-js'
import { type PostageStamp, withTimeout } from '@snaha/swarm-id'
import {
  GNOSIS_CHAIN_ID,
  MultichainClient,
  type MultichainSettings,
  type PostageBatch,
  type PostageWriteConstraints,
  gnosisMainnetSettings,
} from '@swarm-id/multichain'

import { prefix0x } from '$lib/crypto/hex'
import { ttlSecondsFor } from '$lib/payment/purchase'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
import type { Account } from '$lib/types'

/** Upper bound on waiting for one confirmation (the client polls inside it). */
const CONFIRMATION_TIMEOUT_MS = 90_000

/** xDAI budget covering approve + topUp + increaseDepth with ample headroom
 * (each op costs well under 0.001 xDAI at current Gnosis gas prices). */
export const GAS_BUDGET_XDAI_WEI = 5_000_000_000_000_000n // 0.005 xDAI

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

/** The batch-owner key in the 0x-hex form the multichain package signs with. */
function ownerHexKey(signerKey: PrivateKey): `0x${string}` {
  return prefix0x(signerKey.toHex()) as `0x${string}`
}

function batchIdHex(stamp: Pick<PostageStamp, 'batchID'>): `0x${string}` {
  return prefix0x(stamp.batchID.toHex()) as `0x${string}`
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

/**
 * What the owner address is missing for an operation needing `bzzPlur` of BZZ
 * (plus the fixed gas budget). Zeros when the residual balances already cover
 * it — funds parked by an earlier interrupted attempt are consumed first.
 */
export async function fundingShortfall(
  address: string,
  bzzPlur: bigint,
  client?: MultichainClient,
): Promise<OwnerFunds> {
  const chain = client ?? (await postageChain())
  const funds = await ownerFunds(address, chain)
  return {
    xdai: funds.xdai >= GAS_BUDGET_XDAI_WEI ? 0n : GAS_BUDGET_XDAI_WEI - funds.xdai,
    bzz: funds.bzz >= bzzPlur ? 0n : bzzPlur - funds.bzz,
  }
}

/**
 * Ensure the PostageStamp contract may pull `totalPlur` from the owner —
 * approve EXACTLY the missing allowance (never unlimited) and wait for it.
 */
export async function ensureBzzAllowance(
  signerKey: PrivateKey,
  totalPlur: bigint,
  client?: MultichainClient,
): Promise<void> {
  const chain = client ?? (await postageChain())
  const owner = ownerHexKey(signerKey)
  const ownerAddress = signerKey.publicKey().address().toChecksum() as `0x${string}`
  const spender = chain.settings.addresses.postageStamp
  const allowance = await chain.getBzzAllowance(ownerAddress, spender)
  if (allowance >= totalPlur) {
    return
  }
  const hash = await chain.approveBzz({
    amount: totalPlur,
    originPrivateKey: owner,
    spender,
  })
  await withTimeout(
    chain.waitForTransactionSuccess(hash),
    CONFIRMATION_TIMEOUT_MS,
    'The BZZ approval transaction was not confirmed in time.',
  )
}

/**
 * Send + confirm a topUp of `amountPerChunk` PLUR per chunk. The caller must
 * have run `ensureBzzAllowance` for `amountPerChunk << depth` first.
 */
export async function topUpOnChain(
  signerKey: PrivateKey,
  stamp: Pick<PostageStamp, 'batchID'>,
  amountPerChunk: bigint,
  client?: MultichainClient,
): Promise<void> {
  const chain = client ?? (await postageChain())
  const hash = await chain.topUpBatch({
    originPrivateKey: ownerHexKey(signerKey),
    batchId: batchIdHex(stamp),
    amountPerChunk,
  })
  await withTimeout(
    chain.waitForTransactionSuccess(hash),
    CONFIRMATION_TIMEOUT_MS,
    'The top-up transaction was not confirmed in time.',
  )
}

/**
 * Extend as ONE transaction: approve + topUp bundled via EIP-7702.
 * @returns false when this chain has no delegate deployed — the caller then
 *   sends the two operations separately, which is the same work with a
 *   recoverable seam in the middle.
 */
export async function bundledExtend(
  signerKey: PrivateKey,
  stamp: Pick<PostageStamp, 'batchID'>,
  amountPerChunk: bigint,
  totalPlur: bigint,
  client?: MultichainClient,
): Promise<boolean> {
  const chain = client ?? (await postageChain())
  if (!(await chain.supportsBundling())) {
    return false
  }
  const hash = await chain.bundleExtend({
    originPrivateKey: ownerHexKey(signerKey),
    batchId: batchIdHex(stamp),
    amountPerChunk,
    totalPlur,
  })
  await withTimeout(
    chain.waitForTransactionSuccess(hash),
    CONFIRMATION_TIMEOUT_MS,
    'The top-up transaction was not confirmed in time.',
  )
  return true
}

/**
 * Resize as ONE transaction: approve + topUp + increaseDepth bundled via
 * EIP-7702 — in that order, which the contract requires whether or not the
 * calls are atomic. Removes the partial state entirely rather than recovering
 * from it.
 * @returns false when this chain has no delegate deployed.
 */
export async function bundledResize(
  signerKey: PrivateKey,
  stamp: Pick<PostageStamp, 'batchID'>,
  amountPerChunk: bigint,
  totalPlur: bigint,
  newDepth: number,
  client?: MultichainClient,
): Promise<boolean> {
  const chain = client ?? (await postageChain())
  if (!(await chain.supportsBundling())) {
    return false
  }
  const hash = await chain.bundleResize({
    originPrivateKey: ownerHexKey(signerKey),
    batchId: batchIdHex(stamp),
    amountPerChunk,
    totalPlur,
    newDepth,
  })
  await withTimeout(
    chain.waitForTransactionSuccess(hash),
    CONFIRMATION_TIMEOUT_MS,
    'The resize transaction was not confirmed in time.',
  )
  return true
}

/** Send + confirm an increaseDepth — the signer MUST be the batch owner. */
export async function increaseDepthOnChain(
  signerKey: PrivateKey,
  stamp: Pick<PostageStamp, 'batchID'>,
  newDepth: number,
  client?: MultichainClient,
): Promise<void> {
  const chain = client ?? (await postageChain())
  const hash = await chain.increaseDepth({
    originPrivateKey: ownerHexKey(signerKey),
    batchId: batchIdHex(stamp),
    newDepth,
  })
  await withTimeout(
    chain.waitForTransactionSuccess(hash),
    CONFIRMATION_TIMEOUT_MS,
    'The resize transaction was not confirmed in time.',
  )
}

/** Chain state a dialog needs before asking for money or sending anything. */
export interface PostagePreflight {
  batch: PostageBatch
  constraints: PostageWriteConstraints
  /** Live per-chunk balance in PLUR — all planning must start from this. */
  remaining: bigint
}

/**
 * Read the batch + write constraints and refuse early — with user-worded
 * errors — every condition the contract would revert on anyway.
 */
export async function preflightExtend(
  stamp: Pick<PostageStamp, 'batchID'>,
  client?: MultichainClient,
): Promise<PostagePreflight> {
  const chain = client ?? (await postageChain())
  const [batch, constraints] = await Promise.all([
    chain.getPostageBatch(batchIdHex(stamp)),
    chain.getPostageWriteConstraints(),
  ])
  if (!batch) {
    throw new Error('This drive no longer exists on chain — it may have expired.')
  }
  if (constraints.paused) {
    throw new Error("Swarm's payment contract is temporarily paused. Try again later.")
  }
  const remaining = await chain.getRemainingBalance(batchIdHex(stamp))
  if (remaining <= 0n) {
    throw new Error('This drive has expired and can no longer be extended.')
  }
  return { batch, constraints, remaining }
}

/**
 * Extend preflight plus the resize-only rules: the signer must be the on-chain
 * owner, and immutable batches are not resized (the chain would allow it, but
 * Bee-node semantics of diluting an immutable batch are undefined).
 * A batch already at/above `newDepth` is reported via `alreadyResized` — the
 * increase landed in a lost session and must be recorded, not re-sent.
 */
export async function preflightResize(
  stamp: Pick<PostageStamp, 'batchID'>,
  signerKey: PrivateKey,
  newDepth: number,
  client?: MultichainClient,
): Promise<PostagePreflight & { alreadyResized: boolean }> {
  const chain = client ?? (await postageChain())
  const preflight = await preflightExtend(stamp, chain)
  const ownerAddress = signerKey.publicKey().address().toChecksum()
  if (preflight.batch.owner.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new Error('This drive is owned by a different key, so its size cannot be changed here.')
  }
  if (preflight.batch.immutableFlag) {
    throw new Error('This drive is immutable and cannot be resized.')
  }
  return { ...preflight, alreadyResized: preflight.batch.depth >= newDepth }
}

/**
 * Patch the stamp record from chain truth (depth, live per-chunk balance, and
 * the TTL it implies). Called after every confirmed transaction and on dialog
 * open, so an interrupted flow reconciles instead of trusting local state.
 * Returns false when the chain could not answer (record left untouched).
 */
export async function reconcileStampFromChain(
  account: Account,
  stamp: PostageStamp,
  client?: MultichainClient,
): Promise<boolean> {
  const chain = client ?? (await postageChain())
  try {
    const [batch, constraints] = await Promise.all([
      chain.getPostageBatch(batchIdHex(stamp)),
      chain.getPostageWriteConstraints(),
    ])
    if (!batch) {
      return false
    }
    const remaining = await chain.getRemainingBalance(batchIdHex(stamp))
    account.updateStamp(stamp.batchID, {
      depth: batch.depth,
      amount: remaining,
      batchTTL: ttlSecondsFor(remaining, constraints.lastPrice),
    })
    return true
  } catch {
    return false
  }
}

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
import { type PostageStamp, resolvePostageStampContractAddress, withTimeout } from '@snaha/swarm-id'
import {
  MultichainClient,
  type PostageBatch,
  type PostageWriteConstraints,
  gnosisMainnetSettings,
  localAnvilSettings,
} from '@swarm-id/multichain'

import { prefix0x } from '$lib/crypto/hex'
import { LOCAL_POSTAGE_STAMP_CONTRACT_ADDRESS } from '$lib/payment/contract'
import { ttlSecondsFor } from '$lib/payment/purchase'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
import type { Account } from '$lib/types'

/** Upper bound on waiting for one confirmation (the client polls inside it). */
const CONFIRMATION_TIMEOUT_MS = 90_000

/** xDAI budget covering approve + topUp + increaseDepth with ample headroom
 * (each op costs well under 0.001 xDAI at current Gnosis gas prices). */
export const GAS_BUDGET_XDAI_WEI = 5_000_000_000_000_000n // 0.005 xDAI

/**
 * Client for the configured Gnosis RPC. The settings preset follows the RPC's
 * locality exactly like `resolvePostageStampContractAddress`: a local RPC gets
 * the bee-compose anvil preset (chain 4020, dev contract addresses); any
 * remote RPC gets the mainnet preset with the configured URL tried first and
 * the preset's public RPCs as fallback.
 */
export function postageChainClient(
  rpcUrl: string = networkSettingsStore.gnosisRpcUrl,
): MultichainClient {
  const isLocal =
    resolvePostageStampContractAddress(rpcUrl, LOCAL_POSTAGE_STAMP_CONTRACT_ADDRESS) ===
    LOCAL_POSTAGE_STAMP_CONTRACT_ADDRESS
  if (isLocal) {
    const settings = localAnvilSettings()
    return new MultichainClient({ ...settings, rpcUrls: [rpcUrl] })
  }
  const settings = gnosisMainnetSettings()
  return new MultichainClient({
    ...settings,
    rpcUrls: [rpcUrl, ...settings.rpcUrls.filter((url) => url !== rpcUrl)],
  })
}

/**
 * Refuse to sign against an RPC whose chain doesn't match the settings preset
 * (e.g. `gnosisRpcUrl` pointed at an Ethereum node) — an EIP-155 signature on
 * the wrong chain would just be rejected, but the money-touching path must
 * fail with a message that names the actual problem.
 */
async function assertExpectedChain(client: MultichainClient): Promise<void> {
  const actual = await client.getChainId()
  if (actual !== client.settings.chainId) {
    throw new Error(
      `The configured Gnosis RPC reports chain id ${actual} (expected ${client.settings.chainId}). Check the network settings.`,
    )
  }
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
export async function ownerFunds(
  address: string,
  client: MultichainClient = postageChainClient(),
): Promise<OwnerFunds> {
  const owner = prefix0x(address) as `0x${string}`
  const [xdai, bzz] = await Promise.all([
    client.getNativeBalance(owner),
    client.getBzzBalance(owner),
  ])
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
  client: MultichainClient = postageChainClient(),
): Promise<OwnerFunds> {
  const funds = await ownerFunds(address, client)
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
  client: MultichainClient = postageChainClient(),
): Promise<void> {
  await assertExpectedChain(client)
  const owner = ownerHexKey(signerKey)
  const ownerAddress = signerKey.publicKey().address().toChecksum() as `0x${string}`
  const spender = client.settings.addresses.postageStamp
  const allowance = await client.getBzzAllowance(ownerAddress, spender)
  if (allowance >= totalPlur) {
    return
  }
  const hash = await client.approveBzz({
    amount: totalPlur,
    originPrivateKey: owner,
    spender,
  })
  await withTimeout(
    client.waitForTransactionSuccess(hash),
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
  client: MultichainClient = postageChainClient(),
): Promise<void> {
  await assertExpectedChain(client)
  const hash = await client.topUpBatch({
    originPrivateKey: ownerHexKey(signerKey),
    batchId: batchIdHex(stamp),
    amountPerChunk,
  })
  await withTimeout(
    client.waitForTransactionSuccess(hash),
    CONFIRMATION_TIMEOUT_MS,
    'The top-up transaction was not confirmed in time.',
  )
}

/** Send + confirm an increaseDepth — the signer MUST be the batch owner. */
export async function increaseDepthOnChain(
  signerKey: PrivateKey,
  stamp: Pick<PostageStamp, 'batchID'>,
  newDepth: number,
  client: MultichainClient = postageChainClient(),
): Promise<void> {
  await assertExpectedChain(client)
  const hash = await client.increaseDepth({
    originPrivateKey: ownerHexKey(signerKey),
    batchId: batchIdHex(stamp),
    newDepth,
  })
  await withTimeout(
    client.waitForTransactionSuccess(hash),
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
  client: MultichainClient = postageChainClient(),
): Promise<PostagePreflight> {
  const [batch, constraints] = await Promise.all([
    client.getPostageBatch(batchIdHex(stamp)),
    client.getPostageWriteConstraints(),
  ])
  if (!batch) {
    throw new Error('This drive no longer exists on chain — it may have expired.')
  }
  if (constraints.paused) {
    throw new Error("Swarm's payment contract is temporarily paused. Try again later.")
  }
  const remaining = await client.getRemainingBalance(batchIdHex(stamp))
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
  client: MultichainClient = postageChainClient(),
): Promise<PostagePreflight & { alreadyResized: boolean }> {
  const preflight = await preflightExtend(stamp, client)
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
  client: MultichainClient = postageChainClient(),
): Promise<boolean> {
  try {
    const [batch, constraints] = await Promise.all([
      client.getPostageBatch(batchIdHex(stamp)),
      client.getPostageWriteConstraints(),
    ])
    if (!batch) {
      return false
    }
    const remaining = await client.getRemainingBalance(batchIdHex(stamp))
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

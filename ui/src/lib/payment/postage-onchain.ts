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
  MultichainClient,
  type PostageBatch,
  type PostageWriteConstraints,
} from '@swarm-id/multichain'

import { prefix0x } from '$lib/crypto/hex'
import { type OwnerFunds, ownerFunds, postageChain } from '$lib/payment/chain'
import { ttlSecondsFor } from '$lib/payment/purchase'
import type { Account } from '$lib/types'

/** Upper bound on waiting for one confirmation (the client polls inside it). */
const CONFIRMATION_TIMEOUT_MS = 90_000

/** xDAI budget covering approve + topUp + increaseDepth with ample headroom
 * (each op costs well under 0.001 xDAI at current Gnosis gas prices). */
export const GAS_BUDGET_XDAI_WEI = 5_000_000_000_000_000n // 0.005 xDAI

/** Bee's fixed bucket depth; a batch's depth must exceed it. */
const BUCKET_DEPTH = 16
const BATCH_NONCE_BYTES = 32
const HEX_RADIX = 16

/** batchId = keccak256(creator, nonce), so the nonce must never be reused. */
function randomBatchNonce(): `0x${string}` {
  return `0x${Array.from(crypto.getRandomValues(new Uint8Array(BATCH_NONCE_BYTES)))
    .map((byte) => byte.toString(HEX_RADIX).padStart(2, '0'))
    .join('')}`
}

/** The batch-owner key in the 0x-hex form the multichain package signs with. */
function ownerHexKey(signerKey: PrivateKey): `0x${string}` {
  return prefix0x(signerKey.toHex()) as `0x${string}`
}

function batchIdHex(stamp: Pick<PostageStamp, 'batchID'>): `0x${string}` {
  return prefix0x(stamp.batchID.toHex()) as `0x${string}`
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
 * Run a postage operation as ONE atomic EIP-7702 transaction, when the chain
 * has the delegate deployed.
 *
 * @returns false when it does not — the caller then sends the operations
 *   separately, which is the same work with recoverable seams in between.
 */
async function bundled(
  send: (chain: MultichainClient) => Promise<`0x${string}`>,
  timeoutMessage: string,
  client?: MultichainClient,
): Promise<boolean> {
  const chain = client ?? (await postageChain())
  if (!(await chain.supportsBundling())) {
    return false
  }
  await withTimeout(
    chain.waitForTransactionSuccess(await send(chain)),
    CONFIRMATION_TIMEOUT_MS,
    timeoutMessage,
  )
  return true
}

/**
 * Buy a batch atomically: approve + createBatch, owned by the signer that pays.
 * @returns the new batch id, or undefined when the chain cannot bundle.
 */
export async function bundledCreate(
  signerKey: PrivateKey,
  amountPerChunk: bigint,
  depth: number,
  totalPlur: bigint,
  client?: MultichainClient,
): Promise<string | undefined> {
  const chain = client ?? (await postageChain())
  if (!(await chain.supportsBundling())) {
    return undefined
  }
  const created = await chain.bundleCreate({
    originPrivateKey: ownerHexKey(signerKey),
    amountPerChunk,
    depth,
    bucketDepth: BUCKET_DEPTH,
    batchNonce: randomBatchNonce(),
    immutable: false,
    totalPlur,
  })
  await withTimeout(
    chain.waitForTransactionSuccess(created.transactionHash),
    CONFIRMATION_TIMEOUT_MS,
    'The purchase transaction was not confirmed in time.',
  )
  return created.batchId
}

/**
 * Create a batch as its own transaction — the fallback where the chain has no
 * 7702 delegate. The caller must have approved the total first.
 * @returns the new batch id.
 */
export async function createOnChain(
  signerKey: PrivateKey,
  amountPerChunk: bigint,
  depth: number,
  client?: MultichainClient,
): Promise<string> {
  const chain = client ?? (await postageChain())
  const owner = signerKey.publicKey().address().toChecksum() as `0x${string}`
  const created = await chain.createBatch({
    originPrivateKey: ownerHexKey(signerKey),
    owner,
    amount: amountPerChunk,
    depth,
    bucketDepth: BUCKET_DEPTH,
    batchNonce: randomBatchNonce(),
    immutable: false,
  })
  await withTimeout(
    chain.waitForTransactionSuccess(created.transactionHash),
    CONFIRMATION_TIMEOUT_MS,
    'The purchase transaction was not confirmed in time.',
  )
  return created.batchId
}

/** Extend atomically: approve + topUp. False if the chain cannot bundle. */
export function bundledExtend(
  signerKey: PrivateKey,
  stamp: Pick<PostageStamp, 'batchID'>,
  amountPerChunk: bigint,
  totalPlur: bigint,
  client?: MultichainClient,
): Promise<boolean> {
  return bundled(
    (chain) =>
      chain.bundleExtend({
        originPrivateKey: ownerHexKey(signerKey),
        batchId: batchIdHex(stamp),
        amountPerChunk,
        totalPlur,
      }),
    'The top-up transaction was not confirmed in time.',
    client,
  )
}

/**
 * Resize atomically: approve + topUp + increaseDepth — in that order, which the
 * contract requires whether or not the calls are atomic. Removes the partial
 * state entirely rather than recovering from it.
 */
export function bundledResize(
  signerKey: PrivateKey,
  stamp: Pick<PostageStamp, 'batchID'>,
  amountPerChunk: bigint,
  totalPlur: bigint,
  newDepth: number,
  client?: MultichainClient,
): Promise<boolean> {
  return bundled(
    (chain) =>
      chain.bundleResize({
        originPrivateKey: ownerHexKey(signerKey),
        batchId: batchIdHex(stamp),
        amountPerChunk,
        totalPlur,
        newDepth,
      }),
    'The resize transaction was not confirmed in time.',
    client,
  )
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

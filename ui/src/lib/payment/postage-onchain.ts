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
  BUNDLE_GAS,
  MultichainClient,
  type PostageBatch,
  type PostageWriteConstraints,
} from '@swarm-id/multichain'
import { encodeAbiParameters, keccak256 } from 'viem'

import { prefix0x } from '$lib/crypto/hex'
import { type OwnerFunds, ownerFunds, postageChain } from '$lib/payment/chain'
import { ttlSecondsFor } from '$lib/payment/purchase'
import type { Account } from '$lib/types'

/** Upper bound on waiting for one confirmation (the client polls inside it). */
const CONFIRMATION_TIMEOUT_MS = 90_000

/** The gas budget never drops below this, however cheap the chain looks — a
 * price read a moment before a spike would otherwise fund an operation that
 * cannot pay for itself by the time it is sent. */
export const GAS_BUDGET_FLOOR_XDAI_WEI = 5_000_000_000_000_000n // 0.005 xDAI

/** How many times the bundle's own cost the budget covers, so a price that
 * moves between funding and sending does not strand the operation. */
const GAS_PRICE_HEADROOM = 2n

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

/** A batch id and the nonce that will produce it — see {@link planBatchCreation}. */
export interface BatchCreationPlan {
  /** The nonce the create must be sent with; never reused. */
  batchNonce: `0x${string}`
  /** The id the batch will have once that create is mined. */
  batchId: `0x${string}`
}

/**
 * The id the PostageStamp contract gives a batch created by `sender` with
 * `nonce`: `keccak256(abi.encode(msg.sender, nonce))`.
 *
 * `abi.encode`, NOT `encodePacked`: the padded 64-byte preimage is what the
 * deployed contract hashes. Verified against a real `BatchCreated` event — the
 * packed 52-byte form yields an entirely different id — and pinned by that
 * on-chain vector in the unit test, since getting this wrong would journal an
 * id no batch ever has.
 *
 * `msg.sender`, not the `_owner` argument: the two may differ in general (a
 * Bee node buys batches for other owners), but a bundle is sent from the owner
 * EOA to itself and the delegate's calls run in its context — see
 * `multichain/src/postage-bundle.ts` — so here they are the same address.
 */
export function deriveBatchId(sender: string, nonce: `0x${string}`): `0x${string}` {
  // Lower-cased, not passed through: the contract hashes 20 raw bytes, so the
  // display case is noise — but viem rejects a mixed-case address whose EIP-55
  // checksum does not verify, which would turn a cosmetic difference at a call
  // site into a thrown purchase.
  const address = prefix0x(sender).toLowerCase() as `0x${string}`
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [address, nonce]),
  )
}

/**
 * Decide what a batch's id WILL be, before buying it.
 *
 * Picking the nonce picks the id ({@link deriveBatchId}), which is what lets
 * the purchase journal be written before the money moves rather than after it.
 * An id that exists nowhere but a mined receipt is an id a closed tab can lose
 * — and with it a paid-for batch nothing can look up, since no index maps an
 * owner to its batches.
 */
export function planBatchCreation(signerKey: PrivateKey): BatchCreationPlan {
  const batchNonce = randomBatchNonce()
  return {
    batchNonce,
    batchId: deriveBatchId(signerKey.publicKey().address().toHex(), batchNonce),
  }
}

/** The batch-owner key in the 0x-hex form the multichain package signs with. */
function ownerHexKey(signerKey: PrivateKey): `0x${string}` {
  return prefix0x(signerKey.toHex()) as `0x${string}`
}

function batchIdHex(stamp: Pick<PostageStamp, 'batchID'>): `0x${string}` {
  return prefix0x(stamp.batchID.toHex()) as `0x${string}`
}

/**
 * The xDAI an operation must have at the owner address to be sendable at all.
 *
 * A transaction is rejected unless the sender can cover `gas × maxFeePerGas`,
 * and the bundle is sent at the chain's current gas price with a fixed gas
 * limit — so a flat budget is a bet on the price. The old flat 0.005 xDAI lost
 * that bet above ~4 gwei: the payment screens collected exactly the budget, and
 * the operation then refused to send, leaving the money parked at the owner
 * address until Gnosis got cheaper again.
 *
 * The floor still applies, so a cheap chain funds an operation as generously as
 * before. THE one definition of "enough gas": both the shortfall above and the
 * surplus in `funding.ts` measure against this, and they must not disagree
 * about what counts as spare, or the same balance is both owed and refunded.
 */
export async function gasBudgetXdai(client: MultichainClient): Promise<bigint> {
  const priced = BUNDLE_GAS * (await client.getGasPrice()) * GAS_PRICE_HEADROOM
  return priced > GAS_BUDGET_FLOOR_XDAI_WEI ? priced : GAS_BUDGET_FLOOR_XDAI_WEI
}

/**
 * What the owner address is missing for an operation needing `bzzPlur` of BZZ
 * (plus the gas budget). Zeros when the residual balances already cover it —
 * funds parked by an earlier interrupted attempt are consumed first.
 */
export async function fundingShortfall(
  address: string,
  bzzPlur: bigint,
  client?: MultichainClient,
): Promise<OwnerFunds> {
  const chain = client ?? (await postageChain())
  const [funds, gasBudget] = await Promise.all([ownerFunds(address, chain), gasBudgetXdai(chain)])
  return {
    xdai: funds.xdai >= gasBudget ? 0n : gasBudget - funds.xdai,
    bzz: funds.bzz >= bzzPlur ? 0n : bzzPlur - funds.bzz,
  }
}

/**
 * Run a postage operation as ONE atomic EIP-7702 transaction, when the chain
 * has the delegate deployed.
 *
 * The caller has already established that the chain can bundle
 * ({@link assertBundlingSupported}); there is no second path if it cannot.
 */
async function bundled(
  send: (chain: MultichainClient) => Promise<`0x${string}`>,
  timeoutMessage: string,
  client?: MultichainClient,
): Promise<void> {
  const chain = client ?? (await postageChain())
  await withTimeout(
    chain.waitForTransactionSuccess(await send(chain)),
    CONFIRMATION_TIMEOUT_MS,
    timeoutMessage,
  )
}

/**
 * Buy a batch atomically: approve + createBatch, owned by the signer that pays.
 *
 * The nonce comes from the caller — from {@link planBatchCreation}, whose id it
 * has already written down. Generating one here would put the id's first
 * existence inside this call, which is the thing the journal exists to prevent.
 *
 * Confirmation is not waited for again here: `bundleCreate` polls for its own
 * receipt and reads the batch id out of the `BatchCreated` event, so it has
 * already confirmed — or thrown — by the time it returns.
 *
 * @returns the new batch id, as the chain reported it.
 */
export async function bundledCreate(
  signerKey: PrivateKey,
  batchNonce: `0x${string}`,
  amountPerChunk: bigint,
  depth: number,
  totalPlur: bigint,
  client?: MultichainClient,
): Promise<string> {
  const chain = client ?? (await postageChain())
  const created = await chain.bundleCreate({
    originPrivateKey: ownerHexKey(signerKey),
    amountPerChunk,
    depth,
    bucketDepth: BUCKET_DEPTH,
    batchNonce,
    immutable: false,
    totalPlur,
  })
  return created.batchId
}

/** Extend atomically: approve + topUp. */
export function bundledExtend(
  signerKey: PrivateKey,
  stamp: Pick<PostageStamp, 'batchID'>,
  amountPerChunk: bigint,
  totalPlur: bigint,
  client?: MultichainClient,
): Promise<void> {
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
): Promise<void> {
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
/**
 * Refuse a chain that cannot bundle, rather than doing the same work in
 * separate transactions.
 *
 * The sequential path was the only way to reach a half-finished operation —
 * a top-up that lands and a depth increase that then fails — and resuming it
 * needs intent the chain cannot express (see #541). Every chain this product
 * targets carries the delegate, so refusing here costs nothing real and
 * removes the whole class of partial states.
 *
 * Deliberately a precondition, not a branch taken mid-flight: it fails before
 * any money moves.
 */
export async function assertBundlingSupported(client?: MultichainClient): Promise<void> {
  const chain = client ?? (await postageChain())
  if (!(await chain.supportsBundling())) {
    throw new Error(
      'This chain cannot process the payment as a single transaction, so the operation was not started. Nothing has been charged.',
    )
  }
}

export async function preflightExtend(
  stamp: Pick<PostageStamp, 'batchID'>,
  client?: MultichainClient,
): Promise<PostagePreflight> {
  const chain = client ?? (await postageChain())
  await assertBundlingSupported(chain)
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
 * the TTL it implies).
 *
 * Called after every confirmed transaction, and by the resize path when
 * preflight finds the depth increase already landed in a session that was lost
 * — so an interrupted flow records what the chain has rather than what this
 * device last believed.
 *
 * Returns false when the chain could not answer (record left untouched); the
 * callers then fall back to projecting the operation's own outcome, which is
 * why this must not collapse a failed read into a plausible-looking success.
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

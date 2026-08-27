// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The two paid drive operations, executed on-chain with the account's derived
 * batch-owner key: extend (lifespan top-up) and resize (compensating top-up
 * followed by a depth increase).
 *
 * Funding is a seam, not a step: the caller supplies `requestFunding`, which
 * either opens the payment flow or — on a dev chain with no source chain to
 * sign on — transfers from the chain's baked faucet. Whatever it does, it must
 * leave the owner address holding the requested funds; the runner re-checks
 * and proceeds.
 *
 * Resume is chain truth. Both runners re-read the batch before spending, so an
 * operation interrupted by a closed tab or a failed second transaction is
 * detected and continued rather than repeated.
 */
import { BatchId, type PrivateKey } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id'
import type { MultichainClient } from '@swarm-id/multichain'

import { strip0x } from '$lib/crypto/hex'
import { remainingLifespanSeconds } from '$lib/drives'
import { type OwnerFunds, postageChain } from '$lib/payment/chain'
import { fetchExistingBatchFromChain } from '$lib/payment/contract'
import {
  BUCKET_DEPTH,
  CreatePendingError,
  bundledCreate,
  bundledExtend,
  bundledResize,
  createOnChain,
  ensureBzzAllowance,
  fundingShortfall,
  increaseDepthOnChain,
  preflightExtend,
  preflightResize,
  reconcileStampFromChain,
  topUpOnChain,
} from '$lib/payment/postage-onchain'
import {
  type NewStamp,
  type ResizePlan,
  derivePostageSigner,
  extendedStamp,
  resizePlan,
  stampAmountForSeconds,
  ttlSecondsFor,
} from '$lib/payment/purchase'
import type { Account } from '$lib/types'

/** What the owner address is missing, and where it must end up. */
export interface FundingNeed {
  /** 0x-prefixed batch-owner address the funds must reach. */
  destination: string
  /** Missing BZZ in PLUR (0n when the residual balance already covers it). */
  bzz: bigint
  /** Missing xDAI in wei for gas (0n when already funded). */
  xdai: bigint
}

/** Supplied by the caller: make the funds in `need` appear at `destination`. */
export type RequestFunding = (need: FundingNeed) => Promise<void>

/**
 * The last moment before money moves: run after the owner address is funded and
 * before the first spending transaction. Throwing here aborts the operation with
 * nothing spent.
 *
 * The seam exists because cancelling is otherwise invisible to a runner. The
 * pre-spend phase is all chain reads, and when residue from an abandoned attempt
 * already covers the operation there is no shortfall, so no payment screen opens
 * and no cancellation can surface through the funding seam — the run would spend
 * regardless. Callers pass a hook that throws once their attempt is superseded.
 */
export type BeforeSpend = () => void | Promise<void>

/**
 * Coarse progress states for the pending UI. `paying` covers the top-up
 * transaction in BOTH operations — during a resize it buys the larger size's
 * lifespan, so labelling it "extending" there would misdescribe what the user
 * asked for.
 */
export type OperationStep =
  | 'checking'
  | 'funding'
  | 'approving'
  | 'paying'
  | 'resizing'
  | 'recording'

export interface RunOptions {
  account: Account
  drive: PostageStamp
  requestFunding: RequestFunding
  beforeSpend?: BeforeSpend
  onStep?: (step: OperationStep) => void
}

/**
 * Bring the owner address up to the funds an operation needs, via the caller's
 * funding seam. No-op when residual balances already cover it.
 */
async function ensureFunded(
  destination: string,
  bzzNeeded: bigint,
  requestFunding: RequestFunding,
  onStep: ((step: OperationStep) => void) | undefined,
  client?: MultichainClient,
): Promise<void> {
  const chain = client ?? (await postageChain())
  const shortfall: OwnerFunds = await fundingShortfall(destination, bzzNeeded, chain)
  if (shortfall.bzz === 0n && shortfall.xdai === 0n) {
    return
  }
  onStep?.('funding')
  await requestFunding({ destination, bzz: shortfall.bzz, xdai: shortfall.xdai })
  const remainingShortfall = await fundingShortfall(destination, bzzNeeded, chain)
  if (remainingShortfall.bzz > 0n || remainingShortfall.xdai > 0n) {
    throw new Error('The payment did not deliver enough funds. You can retry to finish it.')
  }
}

export interface PurchaseOptions {
  account: Account
  /** Capacity, as a PostageStamp depth. */
  depth: number
  /** How long the drive should last, in seconds. */
  lifespanSeconds: number
  /** What to call the drive. */
  name: string
  requestFunding: RequestFunding
  beforeSpend?: BeforeSpend
  onStep?: (step: OperationStep) => void
}

/**
 * Buy a drive: fund the signer, then create the batch it will own.
 *
 * It goes through the same funding seam as extend and resize.
 *
 * There is no throwaway creator wallet: the derived postage signer buys the
 * batch and is its owner, so nothing has to be handed across afterwards.
 *
 * @returns the new batch id, already recorded on the account.
 */
export async function runPurchase(options: PurchaseOptions): Promise<string> {
  const { account, depth, lifespanSeconds, name, requestFunding, beforeSpend, onStep } = options
  const client = await postageChain()
  onStep?.('checking')

  const constraints = await client.getPostageWriteConstraints()
  if (constraints.paused) {
    throw new Error("Swarm's payment contract is temporarily paused. Try again later.")
  }
  const { signerKey, destination } = await derivePostageSigner(account.derivationKey)

  // The contract refuses anything under ~24h of storage, so a short lifespan
  // must be raised rather than sent to a certain revert.
  const requested = stampAmountForSeconds(constraints.lastPrice, lifespanSeconds)
  const amountPerChunk =
    requested < constraints.minimumInitialBalancePerChunk
      ? constraints.minimumInitialBalancePerChunk
      : requested
  const bzzNeeded = amountPerChunk << BigInt(depth)
  const purchased = {
    account,
    signerKey,
    name,
    depth,
    amountPerChunk,
    lastPrice: constraints.lastPrice,
    onStep,
  }

  await ensureFunded(destination, bzzNeeded, requestFunding, onStep, client)
  await beforeSpend?.()

  onStep?.('paying')
  try {
    const batchId = await bundledCreate(signerKey, amountPerChunk, depth, bzzNeeded, client)
    if (!batchId) {
      // No delegate on this chain: approve, then create, as two transactions.
      onStep?.('approving')
      await ensureBzzAllowance(signerKey, bzzNeeded, client)
      onStep?.('paying')
      const created = await createOnChain(signerKey, amountPerChunk, depth, client)
      return await recordPurchase({ ...purchased, batchId: created })
    }
    return await recordPurchase({ ...purchased, batchId })
  } catch (caught) {
    if (!(caught instanceof CreatePendingError)) {
      throw caught
    }
    // The batch is bought and named; only its confirmation is missing. Record
    // it BEFORE the error surfaces — the id exists nowhere else, so letting it
    // go means the next Try again buys a second drive with the first one's
    // money still spent. The chain-truth reconcile on the next open corrects
    // whatever the projection got wrong.
    await recordPurchase({ ...purchased, batchId: caught.batchId })
    throw caught
  }
}

/** What the record step needs, whether the chain describes the batch or not. */
interface PurchaseRecord {
  account: Account
  signerKey: PrivateKey
  batchId: string
  name: string
  /** The parameters the batch was bought with, for the projection below. */
  depth: number
  amountPerChunk: bigint
  lastPrice: bigint
  onStep: ((step: OperationStep) => void) | undefined
}

/**
 * Attach the new batch to the account: chain truth where the chain will describe
 * it, a projection of what was just bought where it will not.
 *
 * A failed read-back must not fail the purchase: a replica lagging the
 * createBatch that just confirmed answers "no such batch", and nothing else
 * persists the batch id. Record what the spend bought, as the extend and resize
 * paths do when their reconcile fails, and let the next successful read correct
 * it.
 */
async function recordPurchase(record: PurchaseRecord): Promise<string> {
  const { account, signerKey, batchId, name, onStep } = record
  onStep?.('recording')
  const stamp = await fetchExistingBatchFromChain(batchId, signerKey, name).catch(() => undefined)
  account.addStamp(stamp ?? projectedStamp(record))
  return batchId
}

/**
 * The batch as it was just bought, for a chain that cannot yet describe it.
 * The bucket depth and the mutable flag are the ones the create call used, and
 * the lifespan is what the funded per-chunk balance buys at the current price.
 */
function projectedStamp(record: PurchaseRecord): NewStamp {
  return {
    batchID: new BatchId(strip0x(record.batchId)),
    name: record.name,
    signerKey: record.signerKey,
    depth: record.depth,
    bucketDepth: BUCKET_DEPTH,
    amount: record.amountPerChunk,
    // Not knowable without the read-back; only the dev tools display it.
    blockNumber: 0,
    immutableFlag: false,
    utilization: 0,
    usable: true,
    exists: true,
    batchTTL: ttlSecondsFor(record.amountPerChunk, record.lastPrice),
  }
}

export interface ExtendOptions extends RunOptions {
  addedSeconds: number
}

/**
 * Extend a drive's lifespan: approve, then top up the batch.
 *
 * Everything from `beforeSpend` on is a spend whose record must land even if
 * the dialog closed — callers keep this call outside their attempt guard, pass
 * the checkpoint as their cancel seam, and gate only their UI epilogue on
 * `attempt.current`.
 */
export async function runExtend(options: ExtendOptions): Promise<void> {
  const { account, drive, addedSeconds, requestFunding, beforeSpend, onStep } = options
  const client = await postageChain()
  onStep?.('checking')

  if (!account.hasLiveStamp(drive.batchID)) {
    throw new Error('This drive was removed in the meantime.')
  }
  const { batch, constraints } = await preflightExtend(drive, client)
  const { signerKey, destination } = await derivePostageSigner(account.derivationKey)

  const topUpAmount = stampAmountForSeconds(constraints.lastPrice, addedSeconds)
  // The chain's depth, never the record's: `topUp` pulls `amountPerChunk <<
  // depth` as the CONTRACT knows it, so a record lagging a resize (19 against a
  // chain 20) would fund and approve half of what the transaction takes, and
  // every retry would collect a payment and then revert.
  const bzzNeeded = topUpAmount << BigInt(batch.depth)
  await ensureFunded(destination, bzzNeeded, requestFunding, onStep, client)
  await beforeSpend?.()

  onStep?.('paying')
  // One atomic transaction where the chain supports it; otherwise the same two
  // operations in sequence, with an approval left standing in between.
  if (!(await bundledExtend(signerKey, drive, topUpAmount, bzzNeeded, client))) {
    onStep?.('approving')
    await ensureBzzAllowance(signerKey, bzzNeeded, client)
    onStep?.('paying')
    await topUpOnChain(signerKey, drive, topUpAmount, client)
  }

  onStep?.('recording')
  const reconciled = await reconcileStampFromChain(account, drive, client)
  if (!reconciled) {
    // Chain read failed after a confirmed spend — record the projection so the
    // UI never shows the pre-payment state. From the AGED remainder, not the
    // stored snapshot: `updateStamp` re-anchors the TTL's measurement instant to
    // now, so a snapshot patch would resurrect the time already elapsed.
    account.updateStamp(
      drive.batchID,
      extendedStamp(drive, addedSeconds, topUpAmount, remainingLifespanSeconds(drive)),
    )
  }
}

export interface ResizeOptions extends RunOptions {
  newDepth: number
  keepLifespan: boolean
}

/**
 * The depth increase failed after everything payable had already landed.
 *
 * Raised only on the unbundled path, and only once the compensating top-up has
 * landed: the drive is bigger-lifespan, not smaller-anything, so the dialog
 * must not present it as a loss. The retry is not free, though — `resizePlan`
 * re-derives from the live balance the top-up has just raised — which is what
 * the message says. A resize that lets the lifespan shorten pays nothing and
 * fails with a plain error instead.
 */
export class SizeIncreasePendingError extends Error {
  constructor(cause: unknown) {
    super(
      'Your payment went through and the drive’s lifespan is longer, but the size increase did not finish. Trying again will re-price the change against the drive’s new, longer lifespan, so it will cost again — the drive itself is not damaged.',
      { cause },
    )
    this.name = 'SizeIncreasePendingError'
  }
}

/**
 * Grow a drive: compensating top-up FIRST, then the depth increase — the order
 * the contract requires (it checks the post-dilution balance against its
 * minimum before any compensation).
 *
 * Where the chain has the 7702 delegate — which includes Gnosis mainnet — this
 * runs as ONE transaction and there is no partial state to reach.
 *
 * On the unbundled fallback there is: the payment landed and the lifespan grew,
 * only the depth increase is pending. Nothing shrank, so nothing is damaged —
 * but a retry is NOT free. `resizePlan` is re-derived from the LIVE remaining
 * balance, which the top-up has just raised, so keep-lifespan asks for a second
 * top-up sized against the grown figure. Resuming instead would need the target
 * depth persisted on the record: chain state cannot tell a batch topped up for a
 * pending resize from one that always held that balance. See
 * docs/Drive-Payment-Flow.md §6.6.
 */
export async function runResize(options: ResizeOptions): Promise<void> {
  const { account, drive, newDepth, keepLifespan, requestFunding, beforeSpend, onStep } = options
  const client = await postageChain()
  onStep?.('checking')

  if (!account.hasLiveStamp(drive.batchID)) {
    throw new Error('This drive was removed in the meantime.')
  }
  const { signerKey, destination } = await derivePostageSigner(account.derivationKey)
  const preflight = await preflightResize(drive, signerKey, newDepth, client)

  if (preflight.alreadyResized) {
    // The increase landed in a session we lost; record chain truth and finish.
    onStep?.('recording')
    if (!(await reconcileStampFromChain(account, drive, client))) {
      // A failed re-read would otherwise leave the pre-resize record under a
      // success screen. The preflight already read chain truth: use that.
      account.updateStamp(drive.batchID, {
        depth: preflight.batch.depth,
        amount: preflight.remaining,
        batchTTL: ttlSecondsFor(preflight.remaining, preflight.constraints.lastPrice),
      })
    }
    return
  }

  const plan = resizePlan(
    preflight.batch.depth,
    newDepth,
    keepLifespan,
    preflight.remaining,
    preflight.constraints.minimumInitialBalancePerChunk,
    preflight.constraints.lastPrice,
  )

  const bzzNeeded = plan.topUpAmount << BigInt(preflight.batch.depth)
  // Unconditionally: a resize that drops the lifespan needs no BZZ, but it
  // still needs gas, and the owner address may hold none. `fundingShortfall`
  // already reports a gas-only need, and the payment screens already price one.
  await ensureFunded(destination, bzzNeeded, requestFunding, onStep, client)
  await beforeSpend?.()

  // Bundled, there is no seam to fail at: top-up and depth increase land
  // together or not at all, so the partial state below cannot arise.
  onStep?.('paying')
  const bundled = await bundledResize(
    signerKey,
    drive,
    plan.topUpAmount,
    bzzNeeded,
    newDepth,
    client,
  )

  if (!bundled) {
    if (plan.topUpAmount > 0n) {
      onStep?.('approving')
      await ensureBzzAllowance(signerKey, bzzNeeded, client)
      onStep?.('paying')
      await topUpOnChain(signerKey, drive, plan.topUpAmount, client)
      // The money is on-chain: record the grown lifespan before attempting the
      // increase, so a failure here leaves an accurate record.
      account.updateStamp(drive.batchID, plan.afterTopUp)
    }

    onStep?.('resizing')
    try {
      await increaseDepthOnChain(signerKey, drive, newDepth, client)
    } catch (caught) {
      // Only reachable on the unbundled path, and it is two different failures.
      // With a top-up behind it the drive is intact but longer-lived, and a
      // retry re-prices against that and charges again — which is what
      // `SizeIncreasePendingError` says, in a neutral tone, because nothing was
      // lost (#392, §6.6). With no top-up — a resize that lets the lifespan
      // shorten — nothing was paid and nothing grew, so saying so would tell
      // the user their money went somewhere it did not.
      if (plan.topUpAmount === 0n) {
        throw new Error(
          'The size increase did not go through. Nothing was charged for it, so trying again is free.',
          { cause: caught },
        )
      }
      throw new SizeIncreasePendingError(caught)
    }
  }

  onStep?.('recording')
  const reconciled = await reconcileStampFromChain(account, drive, client)
  if (!reconciled) {
    account.updateStamp(drive.batchID, plan.afterDilute)
  }
}

/**
 * The drive's depth as the CHAIN has it, for the forms that price a change
 * before it is committed.
 *
 * The stored record lags a resize that landed in a session we lost, and every
 * figure on those forms is a per-chunk amount `<< depth` — so an estimate taken
 * from the record is out by a factor of two for each step it missed, and the
 * size dropdown offers a size the drive already is. Read once when the dialog
 * opens: only the depth has to be live, the per-chunk amount re-derives locally.
 *
 * A record the chain has moved past is also trued up right here, from the
 * preflight already in hand — this is the "reconciles on dialog open" the
 * interrupted-resize recovery relies on. The size list starts at the drive's
 * real size, so there is no stale option left to re-run the landed resize
 * through; the record catching up IS the resumption.
 *
 * @returns undefined when the chain cannot answer, leaving the caller with the
 *   record it had before.
 */
export async function reconciledChainDepth(
  account: Account,
  drive: PostageStamp,
): Promise<number | undefined> {
  try {
    const client = await postageChain()
    const preflight = await preflightExtend(drive, client)
    if (preflight.batch.depth !== drive.depth && account.hasLiveStamp(drive.batchID)) {
      account.updateStamp(drive.batchID, {
        depth: preflight.batch.depth,
        amount: preflight.remaining,
        batchTTL: ttlSecondsFor(preflight.remaining, preflight.constraints.lastPrice),
      })
    }
    return preflight.batch.depth
  } catch {
    return undefined
  }
}

/**
 * The resize plan for a drive as the chain sees it right now — used by the
 * dialog to price the operation before the user commits. Returns `undefined`
 * when the chain can't be read (the dialog then shows no estimate).
 */
export async function previewResize(
  drive: PostageStamp,
  newDepth: number,
  keepLifespan: boolean,
): Promise<{ plan: ResizePlan; currentDepth: number } | undefined> {
  try {
    const client = await postageChain()
    const preflight = await preflightExtend(drive, client)
    return {
      plan: resizePlan(
        preflight.batch.depth,
        newDepth,
        keepLifespan,
        preflight.remaining,
        preflight.constraints.minimumInitialBalancePerChunk,
        preflight.constraints.lastPrice,
      ),
      currentDepth: preflight.batch.depth,
    }
  } catch {
    return undefined
  }
}

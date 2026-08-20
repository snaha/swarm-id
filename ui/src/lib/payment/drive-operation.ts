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
import type { PostageStamp } from '@snaha/swarm-id'
import type { MultichainClient } from '@swarm-id/multichain'

import { remainingLifespanSeconds } from '$lib/drives'
import { type OwnerFunds, postageChain } from '$lib/payment/chain'
import { fetchExistingBatchFromChain } from '$lib/payment/contract'
import { faultPoint } from '$lib/payment/fault-injection'
import type { OperationJournal, PendingOperation } from '$lib/payment/operation-journal.svelte'
import {
  assertBundlingSupported,
  bundledCreate,
  bundledExtend,
  bundledResize,
  fundingShortfall,
  planBatchCreation,
  preflightExtend,
  preflightResize,
  reconcileStampFromChain,
} from '$lib/payment/postage-onchain'
import {
  type ResizePlan,
  derivePostageSigner,
  extendedStamp,
  resizePlan,
  stampAmountForSeconds,
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

/**
 * What extend and resize both need. No journal: these two operate on a batch
 * the account already has, so an interrupted attempt is found again by reading
 * that batch back — chain truth answers the whole resume question, and there is
 * nothing to write down (unlike a purchase, whose id would otherwise exist
 * nowhere).
 */
export interface RunOptions {
  account: Account
  drive: PostageStamp
  requestFunding: RequestFunding
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
  /**
   * Where this device records the batch it is part-way through buying, so a
   * purchase interrupted between paying and recording can be finished rather
   * than lost. Pass `nullJournal()` when there is nothing to resume into.
   */
  journal: OperationJournal
  onStep?: (step: OperationStep) => void
}

/**
 * Buy a drive: fund the signer, then create the batch it will own.
 *
 * The same shape as extend and resize, and deliberately so — it goes through
 * the same funding seam, so it inherits the payment screens, the rail and the
 * local solver rather than needing a second way to pay for things.
 *
 * Unlike the fund.bzz.limo widget this replaces, there is no throwaway creator
 * wallet: the derived postage signer buys the batch and is its owner, so
 * nothing has to be handed across afterwards and no dust is left behind.
 *
 * @returns the new batch id, already recorded on the account.
 */
export async function runPurchase(options: PurchaseOptions): Promise<string> {
  const { account, depth, lifespanSeconds, name, requestFunding, journal, onStep } = options
  const client = await postageChain()
  onStep?.('checking')

  // A batch this device paid for but never managed to record. Nothing looks
  // batches up by owner, so buying again would abandon it — and its money.
  const orphan = journal.entries().find((entry) => entry.accountId === account.id.toString())
  if (orphan) {
    return recordPurchase(account, orphan.batchId, orphan.name, journal, onStep)
  }

  await assertBundlingSupported(client)
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

  await ensureFunded(destination, bzzNeeded, requestFunding, onStep, client)
  faultPoint('after-funding')

  onStep?.('paying')
  // Write the id down BEFORE spending anything on it. The nonce decides the id,
  // so it can be known here rather than read out of a receipt — and it has to
  // be: the send confirms on chain, not in this tab, and the id exists nowhere
  // else afterwards (not on the account, and in no index the app can search).
  // Journalling first turns a tab that dies mid-send from a lost paid-for drive
  // into a resume.
  const plan = planBatchCreation(signerKey)
  journal.record(purchaseEntry(account, plan.batchId, name))
  const batchId = await bundledCreate(
    signerKey,
    plan.batchNonce,
    amountPerChunk,
    depth,
    bzzNeeded,
    client,
  )
  faultPoint('after-create')
  if (batchId.toLowerCase() !== plan.batchId.toLowerCase()) {
    // Cannot happen while the derivation matches the contract's — and precisely
    // therefore, if it ever does, the chain's answer is the real one and must
    // be written down BEFORE anything acts on it. Recording the new entry ahead
    // of dropping the old leaves no instant with nothing journalled.
    journal.record(purchaseEntry(account, batchId, name))
    journal.clear(account.id.toString(), plan.batchId)
  }
  return recordPurchase(account, batchId, name, journal, onStep)
}

function purchaseEntry(account: Account, batchId: string, name: string): PendingOperation {
  return {
    kind: 'purchase',
    accountId: account.id.toString(),
    batchId,
    name,
    startedAt: Date.now(),
  }
}

/** Read the new batch back from chain truth and attach it to the account. */
async function recordPurchase(
  account: Account,
  batchId: string,
  name: string,
  journal: OperationJournal,
  onStep: ((step: OperationStep) => void) | undefined,
): Promise<string> {
  onStep?.('recording')
  const { signerKey } = await derivePostageSigner(account.derivationKey)
  const stamp = await fetchExistingBatchFromChain(batchId, signerKey, name)
  if (!stamp) {
    // The journal entry stays: the drive is bought and findable, and the
    // Storage tab offers to finish it. Retrying costs nothing.
    throw new Error(
      'The drive was paid for but could not be read back from the chain yet. Nothing is lost — finish it from Storage once the chain catches up.',
    )
  }
  account.addStamp(stamp)
  journal.clear(account.id.toString(), batchId)
  return batchId
}

export interface ExtendOptions extends RunOptions {
  addedSeconds: number
}

/**
 * Extend a drive's lifespan: one bundled transaction that approves the BZZ and
 * tops the batch up.
 *
 * Everything from `bundledExtend` on is a spend whose record must land even if
 * the dialog closed — callers keep this call outside their attempt guard and
 * gate only their UI epilogue on `attempt.current`.
 */
export async function runExtend(options: ExtendOptions): Promise<void> {
  const { account, drive, addedSeconds, requestFunding, onStep } = options
  const client = await postageChain()
  onStep?.('checking')

  if (!account.hasLiveStamp(drive.batchID)) {
    throw new Error('This drive was removed in the meantime.')
  }
  const { constraints } = await preflightExtend(drive, client)
  const { signerKey, destination } = await derivePostageSigner(account.derivationKey)

  const topUpAmount = stampAmountForSeconds(constraints.lastPrice, addedSeconds)
  const bzzNeeded = topUpAmount << BigInt(drive.depth)
  await ensureFunded(destination, bzzNeeded, requestFunding, onStep, client)

  onStep?.('paying')
  // One atomic transaction: approve and top up together, or neither.
  await bundledExtend(signerKey, drive, topUpAmount, bzzNeeded, client)

  onStep?.('recording')
  const reconciled = await reconcileStampFromChain(account, drive, client)
  if (!reconciled) {
    // Chain read failed after a confirmed spend — record the projection so the
    // UI never shows the pre-payment state. From the AGED remaining lifespan,
    // not the stored `batchTTL` snapshot: `updateStamp` re-anchors the TTL's
    // measurement instant to now, so projecting from the snapshot would hand
    // the drive back every day it has already lived through.
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
 * Grow a drive: compensating top-up FIRST, then the depth increase — the order
 * the contract requires (it checks the post-dilution balance against its
 * minimum before any compensation).
 *
 * Both land in ONE transaction, so there is no partial state to reach: a chain
 * without the 7702 delegate is refused in preflight rather than served by a
 * second, seam-ful path (#541).
 */
export async function runResize(options: ResizeOptions): Promise<void> {
  const { account, drive, newDepth, keepLifespan, requestFunding, onStep } = options
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
    await reconcileStampFromChain(account, drive, client)
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
  // still needs gas, and the owner address may hold none. Guarding this on
  // `topUpAmount > 0` meant that case sent a transaction the owner could not
  // pay for, and never asked the user for anything. `fundingShortfall` already
  // reports a gas-only need, and the payment screens already price one.
  await ensureFunded(destination, bzzNeeded, requestFunding, onStep, client)
  faultPoint('after-funding')

  // There is no seam to fail at: the compensating top-up and the depth
  // increase land together or not at all, so a half-resized drive — the state
  // #392 was drawn for — cannot arise.
  onStep?.('paying')
  await bundledResize(signerKey, drive, plan.topUpAmount, bzzNeeded, newDepth, client)

  onStep?.('recording')
  const reconciled = await reconcileStampFromChain(account, drive, client)
  if (!reconciled) {
    account.updateStamp(drive.batchID, plan.afterDilute)
  }
}

/** A priced resize, together with the depth it was priced from. */
export interface ResizePreview {
  plan: ResizePlan
  /**
   * The batch's depth ON CHAIN. The compensating top-up runs before the depth
   * increase, so this — not the stored record's depth — is what the per-chunk
   * cost is spread over. An interrupted resize leaves the two disagreeing, and
   * a price computed from the stale one is out by a factor of 2^Δ.
   */
  currentDepth: number
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
): Promise<ResizePreview | undefined> {
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

export interface ResumeOptions {
  account: Account
  entry: PendingOperation
  journal: OperationJournal
  onStep?: (step: OperationStep) => void
}

/**
 * Finish a purchase a previous session paid for.
 *
 * Free, which is why it can be offered as a plain button: the batch exists and
 * is owned by the account's signer, so all that is left is reading it back and
 * recording it.
 */
export async function resumePending(options: ResumeOptions): Promise<void> {
  const { account, entry, journal, onStep } = options
  await recordPurchase(account, entry.batchId, entry.name, journal, onStep)
}

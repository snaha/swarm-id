// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The two paid drive operations, executed on-chain with the account's derived
 * batch-owner key: extend (lifespan top-up) and resize (compensating top-up
 * followed by a depth increase).
 *
 * Funding is a seam, not a step: the caller supplies `requestFunding`, which
 * either opens the payment flow or — on the local dev chain — transfers from
 * the queen account. Whatever it does, it must leave the owner address holding
 * the requested funds; the runner re-checks and proceeds.
 *
 * Resume is chain truth. Both runners re-read the batch before spending, so an
 * operation interrupted by a closed tab or a failed second transaction is
 * detected and continued rather than repeated.
 */
import type { PostageStamp } from '@snaha/swarm-id'
import type { MultichainClient } from '@swarm-id/multichain'

import {
  type OwnerFunds,
  ensureBzzAllowance,
  fundingShortfall,
  increaseDepthOnChain,
  postageChain,
  preflightExtend,
  preflightResize,
  reconcileStampFromChain,
  topUpOnChain,
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

export interface ExtendOptions extends RunOptions {
  addedSeconds: number
}

/**
 * Extend a drive's lifespan: approve, then top up the batch.
 *
 * Everything from `ensureBzzAllowance` on is a spend whose record must land
 * even if the dialog closed — callers keep this call outside their attempt
 * guard and gate only their UI epilogue on `attempt.current`.
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

  onStep?.('approving')
  await ensureBzzAllowance(signerKey, bzzNeeded, client)
  onStep?.('paying')
  await topUpOnChain(signerKey, drive, topUpAmount, client)

  onStep?.('recording')
  const reconciled = await reconcileStampFromChain(account, drive, client)
  if (!reconciled) {
    // Chain read failed after a confirmed spend — record the projection so the
    // UI never shows the pre-payment state.
    account.updateStamp(
      drive.batchID,
      extendedStamp(drive, addedSeconds, topUpAmount, drive.batchTTL),
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
 * Worth its own type because it is the ONLY partial state a resize can end in,
 * and it is a benign one: the drive is bigger-lifespan, not smaller-anything.
 * The design this replaced ("Lifespan decreased", #392) was drawn for the
 * opposite outcome, which the engine's ordering makes unreachable — so the
 * dialog must not present this as a loss, and must say the retry is free.
 */
export class SizeIncreasePendingError extends Error {
  constructor(cause: unknown) {
    super(
      'Your payment went through and the drive’s lifespan is longer. The size increase did not finish — try again to complete it. No additional payment is needed.',
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
 * The reachable partial state is therefore benign: the payment landed and the
 * lifespan grew, only the (free) depth increase is pending. A retry re-reads
 * the chain, skips what already landed, and finishes without a second payment.
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

  if (plan.topUpAmount > 0n) {
    const bzzNeeded = plan.topUpAmount << BigInt(preflight.batch.depth)
    await ensureFunded(destination, bzzNeeded, requestFunding, onStep, client)

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
    // By here everything the user pays for has already landed — either the
    // top-up confirmed above, or none was needed. So this failure is the
    // benign partial state, and a retry costs nothing but gas dust. Typed so
    // the dialog can say that instead of showing a generic failure (#392).
    throw new SizeIncreasePendingError(caught)
  }

  onStep?.('recording')
  const reconciled = await reconcileStampFromChain(account, drive, client)
  if (!reconciled) {
    account.updateStamp(drive.batchID, plan.afterDilute)
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

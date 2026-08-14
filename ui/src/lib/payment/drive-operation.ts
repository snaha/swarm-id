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
import type { PrivateKey } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id'
import type { MultichainClient } from '@swarm-id/multichain'

import { type OwnerFunds, postageChain } from '$lib/payment/chain'
import { fetchExistingBatchFromChain } from '$lib/payment/contract'
import {
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

export interface PurchaseOptions {
  account: Account
  /** Capacity, as a PostageStamp depth. */
  depth: number
  /** How long the drive should last, in seconds. */
  lifespanSeconds: number
  /** What to call the drive. */
  name: string
  requestFunding: RequestFunding
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
  const { account, depth, lifespanSeconds, name, requestFunding, onStep } = options
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

  await ensureFunded(destination, bzzNeeded, requestFunding, onStep, client)

  onStep?.('paying')
  const batchId = await bundledCreate(signerKey, amountPerChunk, depth, bzzNeeded, client)
  if (!batchId) {
    // No delegate on this chain: approve, then create, as two transactions.
    onStep?.('approving')
    await ensureBzzAllowance(signerKey, bzzNeeded, client)
    onStep?.('paying')
    const created = await createOnChain(signerKey, amountPerChunk, depth, client)
    return recordPurchase(account, signerKey, created, name, onStep)
  }
  return recordPurchase(account, signerKey, batchId, name, onStep)
}

/** Read the new batch back from chain truth and attach it to the account. */
async function recordPurchase(
  account: Account,
  signerKey: PrivateKey,
  batchId: string,
  name: string,
  onStep: ((step: OperationStep) => void) | undefined,
): Promise<string> {
  onStep?.('recording')
  const stamp = await fetchExistingBatchFromChain(batchId, signerKey, name)
  if (!stamp) {
    throw new Error(
      'The drive was paid for but could not be read back from the chain. It will appear once the chain catches up.',
    )
  }
  account.addStamp(stamp)
  return batchId
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
      // Only reachable on the unbundled path. By here the top-up has confirmed
      // (or none was needed), so nothing shrank and the drive is intact — but
      // retrying re-prices against the now-longer lifespan and charges again.
      // Typed so the dialog can say precisely that (#392, §6.6).
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

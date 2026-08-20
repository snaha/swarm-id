// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The paid drive operations, against a faked chain client.
 *
 * What is worth testing here is the ORDER of the irreversible steps, not the
 * arithmetic: a purchase that sends before it writes the batch id down loses a
 * paid-for drive when the tab dies in between, and no amount of correct pricing
 * rescues that.
 */
import { BatchId } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id'
import { encodeAbiParameters, keccak256 } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runExtend, runPurchase } from '$lib/payment/drive-operation'
import type { OperationJournal, PendingOperation } from '$lib/payment/operation-journal.svelte'
import { type StampUpdate, derivePostageSigner, stampAmountForSeconds } from '$lib/payment/purchase'
import type { Account } from '$lib/types'

const DERIVATION_KEY = '11'.repeat(32)
const ACCOUNT_ID = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const DEPTH = 20
const LIFESPAN_SECONDS = 30 * 24 * 60 * 60

/**
 * Everything the mocked modules read, in one hoisted bag — `vi.mock` factories
 * run before the test file's own top-level bindings exist, so they can close
 * over this and nothing else.
 */
const harness = vi.hoisted(() => ({
  /** Every irreversible step, in the order it happened. */
  calls: [] as string[],
  transactionHash: `0x${'ab'.repeat(32)}` as `0x${string}`,
  /** What the create bundle reports back; overridden to force a mismatch. */
  eventBatchId: undefined as string | undefined,
  /** Set to make the bundle fail the way a stalled chain does. */
  sendFails: false,
  /** Balances far past anything an operation asks for: funding is not the subject. */
  ownerXdai: 10n ** 30n,
  ownerBzz: 10n ** 30n,
  /** 1 gwei — a quiet chain, so the gas budget stays at its floor. */
  gasPrice: 1_000_000_000n,
  constraints: { paused: false, lastPrice: 1_000n, minimumInitialBalancePerChunk: 1n },
  /** Filled in per test — the id the fake contract derives from the nonce. */
  batchIdForNonce: (nonce: `0x${string}`): string => nonce,
  /** The batch as the chain has it; only the depth is read back here. */
  batch: {
    owner: '0x0000000000000000000000000000000000000000',
    depth: 20,
    bucketDepth: 16,
    immutableFlag: false,
    normalisedBalance: 0n,
    lastUpdatedBlockNumber: 0n,
  },
  remaining: 1_000n,
  /** Chain reads stop answering once the spend has landed, as a flaky RPC does. */
  readsFailAfterSpend: false,
}))

vi.mock('$lib/payment/chain', () => ({
  postageChain: () =>
    Promise.resolve({
      supportsBundling: () => Promise.resolve(true),
      getPostageWriteConstraints: () => Promise.resolve(harness.constraints),
      getGasPrice: () => Promise.resolve(harness.gasPrice),
      bundleCreate: (options: { batchNonce: `0x${string}` }) => {
        harness.calls.push('send')
        if (harness.sendFails) {
          return Promise.reject(new Error('Timed out waiting for the createBatch bundle receipt.'))
        }
        return Promise.resolve({
          transactionHash: harness.transactionHash,
          batchId: harness.eventBatchId ?? harness.batchIdForNonce(options.batchNonce),
        })
      },
      bundleExtend: () => {
        harness.calls.push('send')
        return Promise.resolve(harness.transactionHash)
      },
      waitForTransactionSuccess: () => Promise.resolve(),
      getPostageBatch: () =>
        harness.readsFailAfterSpend && harness.calls.includes('send')
          ? Promise.reject(new Error('the RPC stopped answering'))
          : Promise.resolve(harness.batch),
      getRemainingBalance: () => Promise.resolve(harness.remaining),
    }),
  ownerFunds: () => Promise.resolve({ xdai: harness.ownerXdai, bzz: harness.ownerBzz }),
}))

vi.mock('$lib/payment/contract', () => ({
  fetchExistingBatchFromChain: (batchId: string) => {
    harness.calls.push(`read:${batchId}`)
    return Promise.resolve({ batchID: new BatchId(batchId.replace(/^0x/, '')) })
  },
}))

/** A journal that logs what it is asked to do, so the order can be asserted. */
function trackingJournal(): OperationJournal {
  let entries: PendingOperation[] = []
  return {
    entries: () => entries,
    find: (accountId, batchId) =>
      entries.find((entry) => entry.accountId === accountId && entry.batchId === batchId),
    record(entry) {
      harness.calls.push(`journal:${entry.batchId}`)
      entries = [...entries.filter((existing) => existing.batchId !== entry.batchId), entry]
    },
    clear(accountId, batchId) {
      harness.calls.push(`clear:${batchId}`)
      entries = entries.filter((entry) => entry.batchId !== batchId)
    },
  }
}

const added: PostageStamp[] = []
const patches: StampUpdate[] = []

function fakeAccount(): Account {
  return {
    id: { toString: () => ACCOUNT_ID },
    derivationKey: DERIVATION_KEY,
    addStamp: (stamp: PostageStamp) => added.push(stamp),
    updateStamp: (_batchID: BatchId, patch: StampUpdate) => patches.push(patch),
    hasLiveStamp: () => true,
  } as unknown as Account
}

/**
 * The batch id the PostageStamp contract derives — `keccak256(abi.encode(
 * msg.sender, nonce))`, verified against a BatchCreated event on chain. Spelled
 * out here independently of the code under test, so a change to either is
 * caught rather than mirrored.
 */
function contractBatchId(sender: `0x${string}`, nonce: `0x${string}`): string {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [sender, nonce]))
}

async function purchase(journal: OperationJournal): Promise<string> {
  return runPurchase({
    account: fakeAccount(),
    depth: DEPTH,
    lifespanSeconds: LIFESPAN_SECONDS,
    name: 'Photos',
    requestFunding: () => Promise.reject(new Error('funding must not be needed here')),
    journal,
  })
}

beforeEach(async () => {
  harness.calls.length = 0
  harness.eventBatchId = undefined
  harness.sendFails = false
  harness.readsFailAfterSpend = false
  added.length = 0
  patches.length = 0
  const { destination } = await derivePostageSigner(DERIVATION_KEY)
  harness.batchIdForNonce = (nonce) => contractBatchId(destination as `0x${string}`, nonce)
})

describe('runPurchase', () => {
  /**
   * The whole point of the journal: the id has to be on disk before the money
   * moves. Written afterwards, a tab that dies during the send leaves a batch
   * that is paid for, owned by the account's signer, and findable by nobody.
   */
  it('writes the batch id down before sending the transaction', async () => {
    const journal = trackingJournal()
    const batchId = await purchase(journal)

    expect(harness.calls).toEqual([
      `journal:${batchId}`,
      'send',
      `read:${batchId}`,
      `clear:${batchId}`,
    ])
    expect(journal.entries()).toEqual([])
  })

  it('predicts the id the chain then reports', async () => {
    // The prediction is the id, not a placeholder for one: the same batch is
    // journalled, bought and recorded.
    const batchId = await purchase(trackingJournal())
    expect(added[0].batchID.toHex()).toBe(batchId.replace(/^0x/, ''))
  })

  it('keeps the entry when the send never confirms', async () => {
    // Money may or may not have moved — which is exactly when an entry must
    // survive, so the drive can be resumed (or dismissed) rather than lost.
    harness.sendFails = true
    const journal = trackingJournal()
    await expect(purchase(journal)).rejects.toThrow(/receipt/)
    expect(journal.entries()).toHaveLength(1)
    expect(harness.calls).toEqual([`journal:${journal.entries()[0].batchId}`, 'send'])
  })

  /**
   * The prediction and the chain cannot disagree, but if they ever did, the
   * chain wins — and the journal has to learn the real id BEFORE anything else
   * uses it, or the resume path would hunt for a batch that does not exist.
   */
  it('journals the chain’s id before using it when it differs', async () => {
    const eventBatchId = `0x${'cd'.repeat(32)}`
    harness.eventBatchId = eventBatchId
    const journal = trackingJournal()
    const batchId = await purchase(journal)

    expect(batchId).toBe(eventBatchId)
    const predicted = harness.calls[0].replace('journal:', '')
    expect(predicted).not.toBe(eventBatchId)
    expect(harness.calls).toEqual([
      `journal:${predicted}`,
      'send',
      `journal:${eventBatchId}`,
      `clear:${predicted}`,
      `read:${eventBatchId}`,
      `clear:${eventBatchId}`,
    ])
    expect(journal.entries()).toEqual([])
  })
})

describe('runExtend', () => {
  const NOW = Date.UTC(2026, 5, 1)
  const SECONDS_PER_DAY = 24 * 60 * 60
  const MEASURED_TTL_SECONDS = 30 * SECONDS_PER_DAY
  const AGE_SECONDS = 10 * SECONDS_PER_DAY
  const ADDED_SECONDS = 5 * SECONDS_PER_DAY
  const MS_PER_SECOND = 1000

  /** A drive bought 30 days' worth of lifespan, 10 days ago. */
  function drive(): PostageStamp {
    return {
      batchID: new BatchId('f9'.repeat(32)),
      depth: harness.batch.depth,
      amount: 500n,
      batchTTL: MEASURED_TTL_SECONDS,
      createdAt: NOW - AGE_SECONDS * MS_PER_SECOND,
    } as unknown as PostageStamp
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * The post-spend chain read is what normally writes the record, and when it
   * fails the projection stands in for it. `account.updateStamp` re-anchors the
   * TTL's measurement instant to now, so the projection has to start from the
   * AGED remaining lifespan: patching from the stored snapshot would hand the
   * drive back the ten days it has already lived through, and the countdown
   * would silently jump forward.
   */
  it('projects from the aged lifespan when the chain read fails', async () => {
    harness.readsFailAfterSpend = true
    const extended = drive()
    await runExtend({
      account: fakeAccount(),
      drive: extended,
      addedSeconds: ADDED_SECONDS,
      requestFunding: () => Promise.reject(new Error('funding must not be needed here')),
    })

    const topUpAmount = stampAmountForSeconds(harness.constraints.lastPrice, ADDED_SECONDS)
    expect(patches).toEqual([
      {
        amount: extended.amount + topUpAmount,
        batchTTL: MEASURED_TTL_SECONDS - AGE_SECONDS + ADDED_SECONDS,
      },
    ])
  })

  it('leaves the record to chain truth when the read succeeds', async () => {
    // Reconciled records come from the chain; the projection is a fallback, not
    // a second writer racing it.
    await runExtend({
      account: fakeAccount(),
      drive: drive(),
      addedSeconds: ADDED_SECONDS,
      requestFunding: () => Promise.reject(new Error('funding must not be needed here')),
    })
    expect(patches).toEqual([
      { depth: harness.batch.depth, amount: harness.remaining, batchTTL: expect.any(Number) },
    ])
  })
})

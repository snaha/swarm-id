// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The paid drive runners, with the chain stubbed at the `postage-onchain` seam.
 * Everything asserted here is about money and memory: what the runners size a
 * spend against, what they persist when a read-back fails, and what they refuse
 * to spend once the caller has cancelled. The account is the real one, so a
 * record that would not survive `PostageStampSchemaV1` fails the test.
 */
import { BatchId, EthAddress, PrivateKey } from '@ethersphere/bee-js'
import type { PostageStamp } from '@snaha/swarm-id'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Account } from '$lib/stores/accounts.svelte'

import { SizeIncreasePendingError, runExtend, runPurchase, runResize } from './drive-operation'
import { CreatePendingError } from './postage-onchain'
import { stampAmountForSeconds, ttlSecondsFor } from './purchase'

// The accounts store reads `browser` and (via the lib storage manager)
// `window.localStorage` at import time; every account here is built directly
// from the class, so nothing is persisted.
vi.mock('$app/environment', () => ({ browser: false }))

vi.hoisted(() => {
  const backing = new Map<string, string>()
  const localStorageStub = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  }
  Object.assign(globalThis, {
    window: {
      localStorage: localStorageStub,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    },
    localStorage: localStorageStub,
  })
})

const chain = vi.hoisted(() => ({ getPostageWriteConstraints: vi.fn() }))
vi.mock('$lib/payment/chain', () => ({ postageChain: () => Promise.resolve(chain) }))

const contract = vi.hoisted(() => ({ fetchExistingBatchFromChain: vi.fn() }))
vi.mock('$lib/payment/contract', () => contract)

const onchain = vi.hoisted(() => ({
  bundledCreate: vi.fn(),
  bundledExtend: vi.fn(),
  bundledResize: vi.fn(),
  createOnChain: vi.fn(),
  ensureBzzAllowance: vi.fn(),
  fundingShortfall: vi.fn(),
  increaseDepthOnChain: vi.fn(),
  preflightExtend: vi.fn(),
  preflightResize: vi.fn(),
  reconcileStampFromChain: vi.fn(),
  topUpOnChain: vi.fn(),
}))
// Partial: `BUCKET_DEPTH` stays the real constant the create call uses, so the
// projected record is checked against it rather than against a copy.
vi.mock('$lib/payment/postage-onchain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/payment/postage-onchain')>()),
  ...onchain,
}))

const OWNER = `0x${'1'.repeat(40)}`
const SIGNER_KEY = new PrivateKey('b'.repeat(64))
vi.mock('$lib/payment/purchase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/payment/purchase')>()),
  derivePostageSigner: () => Promise.resolve({ signerKey: SIGNER_KEY, destination: OWNER }),
}))

const DAY = 24 * 60 * 60
const MS_PER_SECOND = 1000
const BLOCKS_PER_DAY = 17_280n
const PRICE = 24_000n
/** ~1 day of storage, the contract's floor. */
const MINIMUM = BLOCKS_PER_DAY * PRICE
/** Live per-chunk balance: 50 days at PRICE. */
const REMAINING = 50n * BLOCKS_PER_DAY * PRICE
const NOW = 1_800_000_000_000
const BATCH_ID = 'a'.repeat(64)
const CONSTRAINTS = { paused: false, lastPrice: PRICE, minimumInitialBalancePerChunk: MINIMUM }

const requestFunding = vi.fn(() => Promise.resolve())

function stampRecord(overrides: Partial<PostageStamp> = {}): PostageStamp {
  return {
    batchID: new BatchId(BATCH_ID),
    name: 'Drive 1',
    signerKey: SIGNER_KEY,
    depth: 20,
    amount: 1000n,
    bucketDepth: 16,
    blockNumber: 1,
    immutableFlag: false,
    utilization: 0,
    usable: true,
    exists: true,
    batchTTL: 100 * DAY,
    createdAt: NOW,
    ...overrides,
  }
}

function makeAccount(postageStamps: PostageStamp[]): Account {
  return new Account(
    {
      id: new EthAddress('a'.repeat(40)),
      name: 'Test',
      createdAt: NOW,
      derivationKey: 'f'.repeat(64),
      publicKey: `02${'ab'.repeat(32)}`,
      access: { type: 'password', kdfSalt: 'a'.repeat(32), kdfIterations: 1 },
      encryptedSeed: 'ab'.repeat(44),
      devices: [],
      connectedApps: [],
      postageStamps,
    },
    () => undefined,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  chain.getPostageWriteConstraints.mockResolvedValue(CONSTRAINTS)
  onchain.fundingShortfall.mockResolvedValue({ bzz: 0n, xdai: 0n })
  onchain.reconcileStampFromChain.mockResolvedValue(true)
  onchain.bundledCreate.mockResolvedValue(BATCH_ID)
  onchain.createOnChain.mockResolvedValue(BATCH_ID)
  onchain.bundledExtend.mockResolvedValue(true)
  onchain.bundledResize.mockResolvedValue(true)
  onchain.preflightExtend.mockResolvedValue({
    batch: { depth: 20 },
    constraints: CONSTRAINTS,
    remaining: REMAINING,
  })
  onchain.preflightResize.mockResolvedValue({
    batch: { depth: 20 },
    constraints: CONSTRAINTS,
    remaining: REMAINING,
    alreadyResized: false,
  })
  contract.fetchExistingBatchFromChain.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runPurchase', () => {
  it('attaches the batch the chain read back', async () => {
    const account = makeAccount([])
    const { createdAt: _createdAt, ...onChain } = stampRecord({ depth: 21, amount: REMAINING })
    contract.fetchExistingBatchFromChain.mockResolvedValue(onChain)

    await runPurchase({
      account,
      depth: 20,
      lifespanSeconds: 365 * DAY,
      name: 'Photos',
      requestFunding,
    })

    expect(account.stamps[0].depth).toBe(21)
  })

  it('records what was bought when the chain cannot read the batch back yet', async () => {
    // A replica lagging the createBatch that just confirmed answers "no such
    // batch", so the purchase must still record the id it was given.
    const account = makeAccount([])
    contract.fetchExistingBatchFromChain.mockResolvedValue(undefined)

    const batchId = await runPurchase({
      account,
      depth: 20,
      lifespanSeconds: 365 * DAY,
      name: 'Photos',
      requestFunding,
    })

    const amountPerChunk = stampAmountForSeconds(PRICE, 365 * DAY)
    expect(batchId).toBe(BATCH_ID)
    const [stamp] = account.stamps
    expect(stamp.batchID.toHex()).toBe(BATCH_ID)
    expect(stamp.name).toBe('Photos')
    expect(stamp.signerKey).toBe(SIGNER_KEY)
    expect(stamp.depth).toBe(20)
    expect(stamp.bucketDepth).toBe(16)
    expect(stamp.immutableFlag).toBe(false)
    expect(stamp.amount).toBe(amountPerChunk)
    expect(stamp.batchTTL).toBe(ttlSecondsFor(amountPerChunk, PRICE))
    expect(stamp.usable).toBe(true)
    expect(stamp.exists).toBe(true)
  })

  it('records the projection when the read-back endpoint cannot answer at all', async () => {
    const account = makeAccount([])
    contract.fetchExistingBatchFromChain.mockRejectedValue(new Error('RPC unreachable'))

    await runPurchase({
      account,
      depth: 20,
      lifespanSeconds: 365 * DAY,
      name: '',
      requestFunding,
    })

    expect(account.stamps).toHaveLength(1)
    expect(account.stamps[0].batchID.toHex()).toBe(BATCH_ID)
  })

  /**
   * The confirmation wait is the one failure that arrives with the batch id
   * already in hand, and nothing else persists it. Recorded, the chain-truth
   * reconcile on the next open corrects it, and a transaction that never lands
   * leaves a drive the user can remove.
   */
  it.each([
    ['bundled', onchain.bundledCreate],
    ['unbundled', onchain.createOnChain],
  ])(
    'records a %s purchase whose confirmation timed out, then reports it',
    async (_label, call) => {
      const account = makeAccount([])
      onchain.bundledCreate.mockResolvedValue(undefined)
      const pending = new CreatePendingError(
        `0x${BATCH_ID}`,
        `0x${'cd'.repeat(32)}`,
        new Error('The purchase transaction was not confirmed in time.'),
      )
      call.mockRejectedValue(pending)

      await expect(
        runPurchase({
          account,
          depth: 20,
          lifespanSeconds: 365 * DAY,
          name: 'Photos',
          requestFunding,
        }),
      ).rejects.toBe(pending)

      expect(account.stamps).toHaveLength(1)
      expect(account.stamps[0].batchID.toHex()).toBe(BATCH_ID)
      expect(account.stamps[0].name).toBe('Photos')
    },
  )

  it('records the batch bought on the unbundled path too', async () => {
    const account = makeAccount([])
    onchain.bundledCreate.mockResolvedValue(undefined)

    await runPurchase({
      account,
      depth: 20,
      lifespanSeconds: 365 * DAY,
      name: 'Photos',
      requestFunding,
    })

    expect(onchain.ensureBzzAllowance).toHaveBeenCalled()
    expect(account.stamps).toHaveLength(1)
  })
})

describe('runExtend', () => {
  it('sizes the money against the chain depth, not the stored record', async () => {
    // An interrupted resize leaves the record at 19 while the chain says 20.
    // topUp pulls `amountPerChunk << CHAIN depth`, so sizing from the record
    // funds and approves half of what the transaction takes, and it reverts.
    const account = makeAccount([stampRecord({ depth: 19 })])
    onchain.preflightExtend.mockResolvedValue({
      batch: { depth: 20 },
      constraints: CONSTRAINTS,
      remaining: REMAINING,
    })
    onchain.bundledExtend.mockResolvedValue(false)

    await runExtend({ account, drive: account.stamps[0], addedSeconds: 30 * DAY, requestFunding })

    const expected = stampAmountForSeconds(PRICE, 30 * DAY) << 20n
    expect(onchain.fundingShortfall).toHaveBeenCalledWith(OWNER, expected, chain)
    expect(onchain.bundledExtend.mock.calls[0][3]).toBe(expected)
    expect(onchain.ensureBzzAllowance.mock.calls[0][1]).toBe(expected)
  })

  it('projects the extension from the aged remaining lifespan', async () => {
    // `updateStamp` re-anchors the TTL's measurement instant to now, so the
    // patch must carry the AGED remainder — patching from the stored snapshot
    // would resurrect the 10 days that have already elapsed.
    const account = makeAccount([
      stampRecord({ createdAt: NOW - 10 * DAY * MS_PER_SECOND, batchTTL: 100 * DAY }),
    ])
    onchain.reconcileStampFromChain.mockResolvedValue(false)

    await runExtend({ account, drive: account.stamps[0], addedSeconds: 30 * DAY, requestFunding })

    expect(account.stamps[0].batchTTL).toBe(120 * DAY)
    expect(account.stamps[0].amount).toBe(1000n + stampAmountForSeconds(PRICE, 30 * DAY))
  })

  it('leaves the record to the reconcile when it succeeds', async () => {
    const account = makeAccount([stampRecord()])
    const updateStamp = vi.spyOn(account, 'updateStamp')

    await runExtend({ account, drive: account.stamps[0], addedSeconds: 30 * DAY, requestFunding })

    expect(updateStamp).not.toHaveBeenCalled()
  })
})

describe('runResize', () => {
  it('records chain truth when the increase already landed and the reconcile fails', async () => {
    const account = makeAccount([stampRecord({ depth: 20, amount: 1000n, batchTTL: 100 * DAY })])
    onchain.preflightResize.mockResolvedValue({
      batch: { depth: 22 },
      constraints: CONSTRAINTS,
      remaining: REMAINING,
      alreadyResized: true,
    })
    onchain.reconcileStampFromChain.mockResolvedValue(false)

    await runResize({
      account,
      drive: account.stamps[0],
      newDepth: 22,
      keepLifespan: true,
      requestFunding,
    })

    const [stamp] = account.stamps
    expect(stamp.depth).toBe(22)
    expect(stamp.amount).toBe(REMAINING)
    expect(stamp.batchTTL).toBe(ttlSecondsFor(REMAINING, PRICE))
    expect(onchain.bundledResize).not.toHaveBeenCalled()
  })

  /**
   * The partial state the neutral wording was written for: the top-up landed,
   * so the drive is longer-lived and the retry genuinely costs again.
   */
  it('reports a pending size increase once the top-up has landed', async () => {
    const account = makeAccount([stampRecord()])
    onchain.bundledResize.mockResolvedValue(false)
    onchain.increaseDepthOnChain.mockRejectedValue(new Error('reverted'))

    await expect(
      runResize({
        account,
        drive: account.stamps[0],
        newDepth: 22,
        keepLifespan: true,
        requestFunding,
      }),
    ).rejects.toBeInstanceOf(SizeIncreasePendingError)
    expect(onchain.topUpOnChain).toHaveBeenCalled()
  })

  /**
   * A resize that lets the lifespan shorten pays nothing: nothing went through,
   * nothing grew, and a retry costs what this attempt did — nothing.
   */
  it('says nothing was charged when the increase fails with no top-up', async () => {
    const account = makeAccount([stampRecord()])
    onchain.bundledResize.mockResolvedValue(false)
    onchain.increaseDepthOnChain.mockRejectedValue(new Error('reverted'))
    const updateStamp = vi.spyOn(account, 'updateStamp')

    const failure = runResize({
      account,
      drive: account.stamps[0],
      newDepth: 22,
      keepLifespan: false,
      requestFunding,
    })

    await expect(failure).rejects.toThrow(/Nothing was charged/)
    await expect(failure).rejects.not.toBeInstanceOf(SizeIncreasePendingError)
    expect(onchain.topUpOnChain).not.toHaveBeenCalled()
    expect(updateStamp).not.toHaveBeenCalled()
  })

  it('leaves an already-resized record to the reconcile when it succeeds', async () => {
    const account = makeAccount([stampRecord({ depth: 20 })])
    onchain.preflightResize.mockResolvedValue({
      batch: { depth: 22 },
      constraints: CONSTRAINTS,
      remaining: REMAINING,
      alreadyResized: true,
    })
    const updateStamp = vi.spyOn(account, 'updateStamp')

    await runResize({
      account,
      drive: account.stamps[0],
      newDepth: 22,
      keepLifespan: true,
      requestFunding,
    })

    expect(updateStamp).not.toHaveBeenCalled()
  })
})

describe('the pre-spend checkpoint', () => {
  // The cancel that matters is the one the payment screens never see: when
  // residue from an abandoned attempt already covers the operation, there is no
  // shortfall, no payment dialog, and nothing else to abort on.
  const cancelled = new Error('superseded')

  it('aborts a purchase after the funds check and before any transaction', async () => {
    const account = makeAccount([])

    await expect(
      runPurchase({
        account,
        depth: 20,
        lifespanSeconds: 365 * DAY,
        name: 'Photos',
        requestFunding,
        beforeSpend: () => {
          throw cancelled
        },
      }),
    ).rejects.toBe(cancelled)

    expect(onchain.fundingShortfall).toHaveBeenCalled()
    expect(requestFunding).not.toHaveBeenCalled()
    expect(onchain.bundledCreate).not.toHaveBeenCalled()
    expect(onchain.createOnChain).not.toHaveBeenCalled()
    expect(onchain.ensureBzzAllowance).not.toHaveBeenCalled()
    expect(account.stamps).toHaveLength(0)
  })

  it('aborts an extend before the top-up', async () => {
    const account = makeAccount([stampRecord()])
    const updateStamp = vi.spyOn(account, 'updateStamp')

    await expect(
      runExtend({
        account,
        drive: account.stamps[0],
        addedSeconds: 30 * DAY,
        requestFunding,
        beforeSpend: () => Promise.reject(cancelled),
      }),
    ).rejects.toBe(cancelled)

    expect(onchain.fundingShortfall).toHaveBeenCalled()
    expect(onchain.bundledExtend).not.toHaveBeenCalled()
    expect(onchain.topUpOnChain).not.toHaveBeenCalled()
    expect(updateStamp).not.toHaveBeenCalled()
  })

  it('aborts a resize before the top-up and the increase', async () => {
    const account = makeAccount([stampRecord()])

    await expect(
      runResize({
        account,
        drive: account.stamps[0],
        newDepth: 22,
        keepLifespan: true,
        requestFunding,
        beforeSpend: () => {
          throw cancelled
        },
      }),
    ).rejects.toBe(cancelled)

    expect(onchain.fundingShortfall).toHaveBeenCalled()
    expect(onchain.bundledResize).not.toHaveBeenCalled()
    expect(onchain.topUpOnChain).not.toHaveBeenCalled()
    expect(onchain.increaseDepthOnChain).not.toHaveBeenCalled()
  })
})

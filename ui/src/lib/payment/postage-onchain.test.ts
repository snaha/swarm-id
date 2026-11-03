// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId } from '@ethersphere/bee-js'
import type { MultichainClient } from '@swarm-id/multichain'
import { describe, expect, it, vi } from 'vitest'

import type { Account } from '$lib/types'

import { confirmTopUp, readStampsFromChain, reconcileStampFromChain } from './postage-onchain'

vi.mock('$lib/payment/chain', () => ({ postageChain: vi.fn(), ownerFunds: vi.fn() }))

const STAMP = { batchID: new BatchId('ab'.repeat(32)) }
const BEFORE = 1_000n

/** A chain whose batch reads return these normalised balances in turn; an
 *  Error in the list is a failed read. */
function chainReading(...balances: (bigint | Error)[]): MultichainClient {
  const getPostageBatch = vi.fn()
  for (const balance of balances) {
    getPostageBatch.mockImplementationOnce(() =>
      balance instanceof Error
        ? Promise.reject(balance)
        : Promise.resolve({ normalisedBalance: balance }),
    )
  }
  return { getPostageBatch } as unknown as MultichainClient
}

describe('confirmTopUp', () => {
  it('confirms once the chain shows the balance raised, re-reading a lagging replica', async () => {
    const chain = chainReading(BEFORE, new Error('rpc down'), BEFORE + 1n)
    await expect(confirmTopUp(STAMP, BEFORE, chain, 0)).resolves.toBe(true)
  })

  it('refuses a top-up the chain never shows, such as a dry-run shop’s', async () => {
    const chain = chainReading(BEFORE, BEFORE, BEFORE, BEFORE, BEFORE, BEFORE + 1n)
    await expect(confirmTopUp(STAMP, BEFORE, chain, 0)).resolves.toBe(false)
  })
})

describe('readStampsFromChain', () => {
  const GONE = { batchID: new BatchId('cd'.repeat(32)) }

  /** A chain that knows only STAMP, at depth 20, with this price */
  function chain(lastPrice: bigint) {
    const getPostageWriteConstraints = vi.fn(async () => ({ lastPrice }))
    const client = {
      getPostageBatch: vi.fn(async (id: string) =>
        id.endsWith('ab'.repeat(32)) ? { depth: 20 } : undefined,
      ),
      getRemainingBalance: vi.fn(async () => 1_000n),
      getPostageWriteConstraints,
    } as unknown as MultichainClient
    return { client, getPostageWriteConstraints }
  }

  it('reads the price once, and tells a batch gone from a live one', async () => {
    const { client, getPostageWriteConstraints } = chain(1n)
    const [live, gone] = await readStampsFromChain([STAMP, GONE], client)
    expect(live).toMatchObject({ exists: true, usable: true, depth: 20 })
    expect(live?.batchTTL).toBeGreaterThan(0)
    expect(gone).toEqual({ exists: false, usable: false, batchTTL: 0 })
    expect(getPostageWriteConstraints).toHaveBeenCalledTimes(1)
  })

  it('leaves the lifetime out when there is no price to divide by', async () => {
    const [live] = await readStampsFromChain([STAMP], chain(0n).client)
    expect(live).not.toHaveProperty('batchTTL')
  })

  it('reconciles without a price by re-anchoring the stored lifetime, not restarting it', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    const DAY_S = DAY_MS / 1000
    vi.useFakeTimers({ toFake: ['Date'] })
    // Measured a day ago with 30 days left: 29 now, and `updateStamp` restarts the clock
    const record = { ...STAMP, batchTTL: 30 * DAY_S, createdAt: Date.now() - DAY_MS }
    const account = { stamps: [record], updateStamp: vi.fn() } as unknown as Account
    const stamp = record as unknown as Parameters<typeof reconcileStampFromChain>[1]
    await expect(reconcileStampFromChain(account, stamp, chain(0n).client)).resolves.toBe(true)
    expect(vi.mocked(account.updateStamp).mock.calls[0][1]).toMatchObject({
      batchTTL: 29 * DAY_S,
    })
    vi.useRealTimers()
  })

  it('does not reconcile a record to a batch the chain does not show yet', async () => {
    const account = { updateStamp: vi.fn() } as unknown as Account
    const stamp = GONE as Parameters<typeof reconcileStampFromChain>[1]
    await expect(reconcileStampFromChain(account, stamp, chain(1n).client)).resolves.toBe(false)
    expect(account.updateStamp).not.toHaveBeenCalled()
  })
})

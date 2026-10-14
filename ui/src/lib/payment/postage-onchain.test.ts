// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchId } from '@ethersphere/bee-js'
import type { MultichainClient } from '@swarm-id/multichain'
import { describe, expect, it, vi } from 'vitest'

import { confirmTopUp } from './postage-onchain'

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

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { PrivateKey } from '@ethersphere/bee-js'
import type { fetchOnChainBatchStateResult } from '@snaha/swarm-id/internal'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchExistingBatchFromChain } from './contract'

vi.mock('$app/environment', () => ({ browser: false }))

const internal = vi.hoisted(() => ({ fetchOnChainBatchStateResult: vi.fn() }))
vi.mock('@snaha/swarm-id/internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@snaha/swarm-id/internal')>()),
  ...internal,
}))

const SIGNER = new PrivateKey('b'.repeat(64))
const BATCH_ID = 'ab'.repeat(32)
const RPC = { rpcUrl: 'http://rpc.invalid', contractAddress: `0x${'c'.repeat(40)}` }

type OnChainBatchResult = Awaited<ReturnType<typeof fetchOnChainBatchStateResult>>

function found(owner: string): OnChainBatchResult {
  return {
    status: 'found',
    state: {
      batch: {
        owner,
        depth: 20,
        bucketDepth: 16,
        immutableFlag: false,
        normalisedBalance: 10n,
        lastUpdatedBlockNumber: 1n,
      },
      currentTotalOutPayment: 4n,
      lastPrice: 1n,
    },
  }
}

beforeEach(() => {
  internal.fetchOnChainBatchStateResult.mockReset()
})

/**
 * The signer's address must be the on-chain owner: Bee refuses any other
 * stamp, and the upload probe that used to be the only check lets a timeout
 * or 5xx through as "stampable" (#819). The chain read is decisive.
 */
describe('fetchExistingBatchFromChain checks the owner', () => {
  it('accepts the batch when the signer owns it, whatever the case of the hex', async () => {
    const owner = SIGNER.publicKey().address().toChecksum()
    internal.fetchOnChainBatchStateResult.mockResolvedValue(found(owner))
    const stamp = await fetchExistingBatchFromChain(BATCH_ID, SIGNER, undefined, RPC)
    expect(stamp?.depth).toBe(20)
    expect(stamp?.amount).toBe(6n)
  })

  it('rejects a batch owned by another key, naming both addresses', async () => {
    const other = `0x${'1'.repeat(40)}`
    internal.fetchOnChainBatchStateResult.mockResolvedValue(found(other))
    await expect(fetchExistingBatchFromChain(BATCH_ID, SIGNER, undefined, RPC)).rejects.toThrow(
      /owned by 0x1{40}, not by this signer key/,
    )
  })

  it('still returns undefined for a batch the contract does not know', async () => {
    internal.fetchOnChainBatchStateResult.mockResolvedValue({ status: 'not-found' })
    await expect(fetchExistingBatchFromChain(BATCH_ID, SIGNER, undefined, RPC)).resolves.toBe(
      undefined,
    )
  })
})

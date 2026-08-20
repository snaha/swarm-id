// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { PrivateKey } from '@ethersphere/bee-js'
import { BUNDLE_GAS, type MultichainClient } from '@swarm-id/multichain'
import { describe, expect, it, vi } from 'vitest'

import {
  GAS_BUDGET_FLOOR_XDAI_WEI,
  deriveBatchId,
  gasBudgetXdai,
  planBatchCreation,
} from '$lib/payment/postage-onchain'

// This module resolves a chain client on import paths the tests never take.
vi.mock('$lib/payment/chain', () => ({
  postageChain: () => Promise.reject(new Error('no chain in this test')),
  ownerFunds: () => Promise.reject(new Error('no chain in this test')),
}))

/**
 * A real `createBatch` from the PostageStamp deployment: the sender and nonce
 * of the transaction, and the batch id the contract emitted in `BatchCreated`.
 * Captured from the chain rather than invented, because the point of the
 * assertion is that our arithmetic is the contract's — an id derived from the
 * packed (52-byte) preimage passes every self-consistent test and names a batch
 * that does not exist.
 */
const ON_CHAIN = {
  sender: '0xb2323309241d4a27dd0fd5e673d82634cfa35415',
  nonce: '0x63152007778ce1074723e504ed8f7e5abe98b4cd2bae8885ad6c0c219087e278',
  batchId: '0x91364116636be6e1a8555625152f38c274abcf347ef20d159b1bc2d6f34d2a3b',
} as const

describe('deriveBatchId', () => {
  it('reproduces the id the contract emitted for a real create', () => {
    expect(deriveBatchId(ON_CHAIN.sender, ON_CHAIN.nonce)).toBe(ON_CHAIN.batchId)
  })

  it('accepts the bare-hex address form the signer hands out', () => {
    expect(deriveBatchId(ON_CHAIN.sender.slice(2), ON_CHAIN.nonce)).toBe(ON_CHAIN.batchId)
  })

  it('is case-insensitive in the address, as EIP-55 display makes it', () => {
    expect(deriveBatchId('0xB2323309241D4A27DD0FD5E673D82634CFA35415', ON_CHAIN.nonce)).toBe(
      ON_CHAIN.batchId,
    )
  })
})

describe('gasBudgetXdai', () => {
  const GWEI = 1_000_000_000n
  const clientAt = (gasPrice: bigint) =>
    ({ getGasPrice: () => Promise.resolve(gasPrice) }) as unknown as MultichainClient

  it('keeps the floor while gas is cheap', async () => {
    await expect(gasBudgetXdai(clientAt(GWEI))).resolves.toBe(GAS_BUDGET_FLOOR_XDAI_WEI)
  })

  /**
   * The case the fixed budget got wrong. A transaction needs a balance of
   * `gas × maxFeePerGas` to be sendable at all, so a Gnosis gas spike put the
   * bundle's cost above a budget the funding screens had just collected exactly
   * — leaving the user's money parked at the owner address and the operation
   * refusing to send, with nothing to do but wait for prices to fall.
   */
  it('follows the gas price once it outgrows the floor', async () => {
    const spike = 50n * GWEI
    await expect(gasBudgetXdai(clientAt(spike))).resolves.toBe(BUNDLE_GAS * spike * 2n)
  })

  it('always covers the bundle at the price it would be sent at', async () => {
    // Both sides of the max(), with headroom to spare: a budget merely equal to
    // the cost leaves nothing for a price that moved between quote and send.
    for (const gasPrice of [GWEI / 10n, GWEI, 5n * GWEI, 100n * GWEI]) {
      const budget = await gasBudgetXdai(clientAt(gasPrice))
      expect(budget).toBeGreaterThanOrEqual(BUNDLE_GAS * gasPrice)
    }
  })
})

describe('planBatchCreation', () => {
  const signerKey = new PrivateKey('ee'.repeat(32))

  it('predicts the id of the nonce it picked', () => {
    const plan = planBatchCreation(signerKey)
    expect(plan.batchId).toBe(
      deriveBatchId(signerKey.publicKey().address().toHex(), plan.batchNonce),
    )
  })

  it('never reuses a nonce', () => {
    // Reuse would collide with a batch the same owner already bought, and the
    // contract would revert the purchase the journal already promised.
    // Few, because each plan pays for a public-key derivation; a nonce that
    // repeated at all would repeat within any handful.
    const SAMPLES = 8
    const nonces = new Set(
      Array.from({ length: SAMPLES }, () => planBatchCreation(signerKey).batchNonce),
    )
    expect(nonces.size).toBe(SAMPLES)
  })
})

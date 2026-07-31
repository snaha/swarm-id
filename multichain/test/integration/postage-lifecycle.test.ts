// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Full postage lifecycle against the bee-compose anvil chain, with NO Bee
 * node involvement — the point of the package. Mirrors production roles:
 * the queen dev account plays the widget's temp wallet (creator/payer), a
 * fresh random key plays the derived batch-owner signer.
 *
 * Run with:
 *   pnpm dev:bee:detach   # from the repo root; only the anvil node is needed
 *   pnpm --filter @swarm-id/multichain test:integration
 */

import { beforeAll, describe, expect, it } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { MultichainClient, localAnvilSettings } from "../../src/index"
import { RollingValueProvider } from "cafe-utility"
import { createLocalBatch, fundLocalAccount } from "../../src/dev"
import { isAnvilReachable } from "./anvil"

const anvilReachable = await isAnvilReachable()

const DEPTH = 20
const NEW_DEPTH = 21
const XDAI_GAS_FUNDING = 50_000_000_000_000_000n // 0.05 xDAI

describe.skipIf(!anvilReachable)("postage lifecycle on anvil", () => {
  const settings = localAnvilSettings()
  const client = new MultichainClient(settings)
  const rpcProvider = new RollingValueProvider(settings.rpcUrls)
  const ownerPrivateKey = generatePrivateKey()
  const owner = privateKeyToAccount(ownerPrivateKey).address

  // Sized off the live floor so increaseDepth(+1) clears the post-dilution
  // minimum: 3x leaves headroom for balance aging during the test.
  let minimumPerChunk = 0n
  let batchId: `0x${string}`

  beforeAll(async () => {
    const constraints = await client.getPostageWriteConstraints()
    expect(constraints.paused).toBe(false)
    expect(constraints.minimumInitialBalancePerChunk).toBeGreaterThan(0n)
    minimumPerChunk = constraints.minimumInitialBalancePerChunk

    const topUpTotal = minimumPerChunk << BigInt(DEPTH)
    await fundLocalAccount(
      { to: owner, xdai: XDAI_GAS_FUNDING, bzzPlur: topUpTotal * 2n },
      settings,
      rpcProvider,
    )

    const created = await createLocalBatch(
      { owner, depth: DEPTH, amountPerChunk: minimumPerChunk * 3n },
      settings,
      rpcProvider,
    )
    batchId = created.batchId
  })

  it("created the batch owned by the derived-signer stand-in", async () => {
    const batch = await client.getPostageBatch(batchId)
    expect(batch).toBeDefined()
    expect(batch?.owner.toLowerCase()).toBe(owner.toLowerCase())
    expect(batch?.depth).toBe(DEPTH)
    expect(batch?.immutableFlag).toBe(false)
  })

  it("tops up the batch from the owner key (approve + topUp)", async () => {
    const before = await client.getRemainingBalance(batchId)

    const topUpTotal = minimumPerChunk << BigInt(DEPTH)
    const approveHash = await client.approveBzz({
      amount: topUpTotal,
      originPrivateKey: ownerPrivateKey,
      spender: settings.addresses.postageStamp,
    })
    await client.waitForTransactionSuccess(approveHash)

    const topUpHash = await client.topUpBatch({
      originPrivateKey: ownerPrivateKey,
      batchId,
      amountPerChunk: minimumPerChunk,
    })
    await client.waitForTransactionSuccess(topUpHash)

    // Balance ages a little between reads; assert the bulk of the top-up.
    const after = await client.getRemainingBalance(batchId)
    expect(after - before).toBeGreaterThan(minimumPerChunk / 2n)
  })

  it("increases depth from the owner key, halving the per-chunk balance", async () => {
    const before = await client.getRemainingBalance(batchId)

    const hash = await client.increaseDepth({
      originPrivateKey: ownerPrivateKey,
      batchId,
      newDepth: NEW_DEPTH,
    })
    await client.waitForTransactionSuccess(hash)

    const batch = await client.getPostageBatch(batchId)
    expect(batch?.depth).toBe(NEW_DEPTH)
    const after = await client.getRemainingBalance(batchId)
    expect(after).toBeLessThan(before)
  })

  it("rejects increaseDepth from a non-owner (NotBatchOwner)", async () => {
    const strangerPrivateKey = generatePrivateKey()
    const stranger = privateKeyToAccount(strangerPrivateKey).address
    await fundLocalAccount(
      { to: stranger, xdai: XDAI_GAS_FUNDING, bzzPlur: 0n },
      settings,
      rpcProvider,
    )

    const hash = await client.increaseDepth({
      originPrivateKey: strangerPrivateKey,
      batchId,
      newDepth: NEW_DEPTH + 1,
    })
    await expect(client.waitForTransactionSuccess(hash)).rejects.toThrow(
      /reverted/,
    )

    const batch = await client.getPostageBatch(batchId)
    expect(batch?.depth).toBe(NEW_DEPTH)
  })
})

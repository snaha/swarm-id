// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The whole production Gnosis path, against REAL mainnet contracts.
 *
 * An anvil fork of Gnosis carries the actual PostageStamp, the actual BZZ
 * token and the actual SushiSwap pools, so every leg the multichain package
 * performs in production runs here unmodified — the same code, the same
 * addresses, the same liquidity:
 *
 *   xDAI arrives (bridge stand-in) → swap xDAI→BZZ on SushiSwap
 *   → approve → createBatch(owner = the account's signer)
 *   → leftover xDAI to the owner → owner tops up → owner increases depth
 *
 * Only the first step is faked: a cross-chain bridge cannot be forked, so the
 * xDAI is minted with anvil's setBalance. Everything after it is genuine.
 *
 * Run with:
 *   pnpm dev:chain:detach    # repo root; the baked chain on :8545
 *   pnpm --filter @swarm-id/multichain test:fork
 */

import { beforeAll, describe, expect, it } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { MultichainClient, gnosisMainnetSettings } from "../../src/index"
import {
  FORK_RPC_URL,
  isGnosisForkReachable,
  randomNonce,
  setNativeBalance,
} from "./fork"

const forkUp = await isGnosisForkReachable()

const XDAI = 10n ** 18n
/** Funds the whole run: swap input, batch cost and every gas fee. */
const STARTING_XDAI = XDAI
/** Small enough that the shallow BZZ pool barely moves. */
const SWAP_XDAI = XDAI / 20n
/** Smallest batch the contract accepts (bucketDepth 16 < depth). */
const DEPTH = 17
const NEW_DEPTH = 18
const BUCKET_DEPTH = 16
/** Headroom over the ~24h minimum so the depth increase clears its floor. */
const FLOOR_MULTIPLE = 4n
describe.skipIf(!forkUp)("full purchase path on a Gnosis fork", () => {
  // The production settings, pointed at the fork — the mainnet addresses are
  // exactly what we want to exercise.
  const settings = gnosisMainnetSettings({ rpcUrls: [FORK_RPC_URL] })
  const client = new MultichainClient(settings)

  // The widget's throwaway payer, and the account's own postage signer.
  const payerKey = generatePrivateKey()
  const payer = privateKeyToAccount(payerKey).address
  const ownerKey = generatePrivateKey()
  const owner = privateKeyToAccount(ownerKey).address

  let minimumPerChunk = 0n
  let batchId: `0x${string}`

  // Deliberately no snapshot/revert around this suite. A Bee node following the
  // chain records the block it has processed and never re-scans below it, so
  // rewinding under a running cluster desyncs it permanently. The run costs
  // 0.05 xDAI of a pool with ~50 xDAI of warmed range, and `pnpm bake` in
  // bee-compose resets it outright.
  beforeAll(async () => {
    expect(await client.getChainId()).toBe(settings.chainId)
    const constraints = await client.getPostageWriteConstraints()
    expect(constraints.paused).toBe(false)
    minimumPerChunk = constraints.minimumInitialBalancePerChunk
    // The bridge delivering xDAI to the payer — the one faked step.
    await setNativeBalance(payer, STARTING_XDAI)
  })

  it("quotes and swaps xDAI for BZZ on the real SushiSwap pool", async () => {
    const quoted = await client.quoteBzzOutForXdaiIn(SWAP_XDAI)
    expect(quoted).toBeGreaterThan(0n)

    const hash = await client.swapXdaiToBzz({
      originPrivateKey: payerKey,
      amountXdai: SWAP_XDAI,
      recipient: payer,
    })
    await client.waitForTransactionSuccess(hash)

    const balance = await client.getBzzBalance(payer)
    // Filled within the swap's own slippage bound.
    expect(balance).toBeGreaterThan((quoted * 99n) / 100n)
  })

  it("creates a batch owned by the account signer, paid for by the payer", async () => {
    const amountPerChunk = minimumPerChunk * FLOOR_MULTIPLE
    const total = amountPerChunk << BigInt(DEPTH)
    expect(await client.getBzzBalance(payer)).toBeGreaterThan(total)

    const approveHash = await client.approveBzz({
      amount: total,
      originPrivateKey: payerKey,
      spender: settings.addresses.postageStamp,
    })
    await client.waitForTransactionSuccess(approveHash)

    const created = await client.createBatch({
      originPrivateKey: payerKey,
      owner,
      depth: DEPTH,
      amount: amountPerChunk,
      bucketDepth: BUCKET_DEPTH,
      batchNonce: randomNonce(),
      immutable: false,
    })
    batchId = created.batchId

    const batch = await client.getPostageBatch(batchId)
    expect(batch?.owner.toLowerCase()).toBe(owner.toLowerCase())
    expect(batch?.depth).toBe(DEPTH)
    expect(batch?.immutableFlag).toBe(false)
  })

  it("hands the leftover xDAI and BZZ to the owner, as the widget does", async () => {
    const leftoverBzz = await client.getBzzBalance(payer)
    if (leftoverBzz > 0n) {
      const hash = await client.transferBzz({
        amount: leftoverBzz,
        originPrivateKey: payerKey,
        to: owner,
      })
      await client.waitForTransactionSuccess(hash)
    }
    // Gas for the owner's own operations below.
    const gas = STARTING_XDAI / 10n
    const hash = await client.transferNative({
      amount: gas,
      originPrivateKey: payerKey,
      to: owner,
    })
    await client.waitForTransactionSuccess(hash)

    expect(await client.getNativeBalance(owner)).toBeGreaterThanOrEqual(gas)
    expect(await client.getBzzBalance(owner)).toBe(leftoverBzz)
  })

  it("tops the batch up from the owner key", async () => {
    const before = await client.getRemainingBalance(batchId)
    const total = minimumPerChunk << BigInt(DEPTH)

    const approveHash = await client.approveBzz({
      amount: total,
      originPrivateKey: ownerKey,
      spender: settings.addresses.postageStamp,
    })
    await client.waitForTransactionSuccess(approveHash)

    const topUpHash = await client.topUpBatch({
      originPrivateKey: ownerKey,
      batchId,
      amountPerChunk: minimumPerChunk,
    })
    await client.waitForTransactionSuccess(topUpHash)

    expect(await client.getRemainingBalance(batchId)).toBeGreaterThan(before)
  })

  it("increases the depth from the owner key", async () => {
    const hash = await client.increaseDepth({
      originPrivateKey: ownerKey,
      batchId,
      newDepth: NEW_DEPTH,
    })
    await client.waitForTransactionSuccess(hash)

    const batch = await client.getPostageBatch(batchId)
    expect(batch?.depth).toBe(NEW_DEPTH)
  })

  it("refuses a depth increase from anyone but the owner", async () => {
    const strangerKey = generatePrivateKey()
    await setNativeBalance(privateKeyToAccount(strangerKey).address, XDAI)

    const hash = await client.increaseDepth({
      originPrivateKey: strangerKey,
      batchId,
      newDepth: NEW_DEPTH + 1,
    })
    await expect(client.waitForTransactionSuccess(hash)).rejects.toThrow(
      /reverted/,
    )
    expect((await client.getPostageBatch(batchId))?.depth).toBe(NEW_DEPTH)
  })
})

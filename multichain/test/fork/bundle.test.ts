// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The atomic EIP-7702 path, against REAL mainnet contracts on a Gnosis fork.
 *
 * Two things need proving, and only one of them is about success:
 *
 *   1. A bundle really does all of approve + topUp + increaseDepth in ONE
 *      transaction — and in that order, because the contract's floor check
 *      makes any other order revert whether or not the calls are atomic.
 *   2. `supportsBundling` is honest. There is no sequential fallback any more,
 *      so a false REFUSES the operation outright: a wrong answer either strands
 *      a chain that can pay atomically, or sends a bundle to a chain that will
 *      execute nothing and still report success.
 *
 * Run with:
 *   pnpm dev:chain:detach    # repo root; the baked chain on :9545
 *   pnpm --filter @swarm-id/multichain test:fork
 */

import { beforeAll, describe, expect, it } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { MultichainClient, gnosisMainnetSettings } from "../../src/index"
import { devRpc, ensureBundlingDelegate, fundLocalAccount } from "../../src/dev"
import {
  FORK_RPC_URL,
  isGnosisForkReachable,
  randomNonce,
  setNativeBalance,
} from "./fork"

const forkUp = await isGnosisForkReachable()

const XDAI = 10n ** 18n
const DEPTH = 17
const NEW_DEPTH = 18
const BUCKET_DEPTH = 16
/** Headroom over the ~24h minimum so the depth increase clears its floor. */
const FLOOR_MULTIPLE = 4n
/** Covers the batch plus every top-up this suite makes, with room to spare. */
const OWNER_BZZ = 5n * 10n ** 16n
describe.skipIf(!forkUp)("atomic postage bundle on a Gnosis fork", () => {
  const settings = gnosisMainnetSettings({ rpcUrls: [FORK_RPC_URL] })
  const client = new MultichainClient(settings)
  const delegate = settings.addresses.eip7702Delegate

  const ownerKey = generatePrivateKey()
  const owner = privateKeyToAccount(ownerKey).address

  let minimumPerChunk = 0n
  let batchId: `0x${string}`

  beforeAll(async () => {
    await ensureBundlingDelegate(settings)
    const constraints = await client.getPostageWriteConstraints()
    minimumPerChunk = constraints.minimumInitialBalancePerChunk
    await setNativeBalance(owner, XDAI)
    // From the chain's faucet rather than a swap: this suite is about the
    // bundle, and every swap moves a real and thin BZZ pool.
    await fundLocalAccount(
      { to: owner, xdai: 0n, bzzPlur: OWNER_BZZ },
      settings,
    )

    // Give the owner a batch it owns outright, and the BZZ a top-up will pull.
    // Created by the owner itself here — the creator/owner split is the
    // purchase suite's subject, not this one's.
    const perChunk = minimumPerChunk * FLOOR_MULTIPLE
    const approval = await client.approveBzz({
      amount: OWNER_BZZ,
      originPrivateKey: ownerKey,
      spender: settings.addresses.postageStamp,
    })
    await client.waitForTransactionSuccess(approval)
    const created = await client.createBatch({
      originPrivateKey: ownerKey,
      owner,
      amount: perChunk,
      depth: DEPTH,
      bucketDepth: BUCKET_DEPTH,
      batchNonce: randomNonce(),
      immutable: false,
    })
    await client.waitForTransactionSuccess(created.transactionHash)
    batchId = created.batchId as `0x${string}`
  })

  it("reports bundling as available once the delegate is deployed", async () => {
    expect(await client.supportsBundling()).toBe(true)
  })

  it("extends in a single transaction that approves and tops up", async () => {
    const before = await client.getRemainingBalance(batchId)
    const amountPerChunk = minimumPerChunk
    const totalPlur = amountPerChunk << BigInt(DEPTH)

    const hash = await client.bundleExtend({
      originPrivateKey: ownerKey,
      batchId,
      amountPerChunk,
      totalPlur,
    })
    await client.waitForTransactionSuccess(hash)

    expect(await client.getRemainingBalance(batchId)).toBeGreaterThan(before)
  })

  it("resizes in a single transaction: approve, top up, then increase depth", async () => {
    const remaining = await client.getRemainingBalance(batchId)
    // keep-lifespan: top up by R × (2^Δ − 1), paid at the OLD depth, so the
    // post-dilution per-chunk balance lands back on R.
    const amountPerChunk = remaining * (2n ** BigInt(NEW_DEPTH - DEPTH) - 1n)
    const totalPlur = amountPerChunk << BigInt(DEPTH)

    const hash = await client.bundleResize({
      originPrivateKey: ownerKey,
      batchId,
      amountPerChunk,
      totalPlur,
      newDepth: NEW_DEPTH,
    })
    await client.waitForTransactionSuccess(hash)

    const batch = await client.getPostageBatch(batchId)
    expect(batch?.depth).toBe(NEW_DEPTH)
    // The lifespan survived the dilution, which is the whole point of the
    // compensating top-up riding in the same transaction.
    expect(await client.getRemainingBalance(batchId)).toBeGreaterThanOrEqual(
      remaining / 2n,
    )
  })

  it("sends it as a type-4 transaction from the owner to itself", async () => {
    const amountPerChunk = minimumPerChunk
    const hash = await client.bundleExtend({
      originPrivateKey: ownerKey,
      batchId,
      amountPerChunk,
      totalPlur: amountPerChunk << BigInt(NEW_DEPTH),
    })
    await client.waitForTransactionSuccess(hash)

    const sent = (await devRpc(FORK_RPC_URL, "eth_getTransactionByHash", [
      hash,
    ])) as {
      type: string
      from: string
      to: string
    }
    expect(sent.type).toBe("0x4")
    // Self-call: the delegate's code runs in the EOA's context, which is what
    // keeps msg.sender the batch owner for topUp and increaseDepth alike.
    expect(sent.to.toLowerCase()).toBe(sent.from.toLowerCase())
    expect(sent.from.toLowerCase()).toBe(owner.toLowerCase())

    // The delegation indicator EIP-7702 leaves behind: 0xef0100 || delegate.
    // It PERSISTS — the owner EOA reads as a contract from here on.
    const code = (await devRpc(FORK_RPC_URL, "eth_getCode", [
      owner,
      "latest",
    ])) as string
    expect(code.toLowerCase()).toBe(
      `0xef0100${delegate.slice(2).toLowerCase()}`,
    )
  })

  it("reports bundling as unavailable where the delegate is absent", async () => {
    // The fallback matters: without this being honest, a chain lacking the
    // delegate would send a transaction that quietly does nothing at all.
    await devRpc(FORK_RPC_URL, "anvil_setCode", [delegate, "0x"])
    try {
      expect(await client.supportsBundling()).toBe(false)
    } finally {
      await ensureBundlingDelegate(settings)
    }
    expect(await client.supportsBundling()).toBe(true)
  })
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Warms a live Gnosis fork so its state can be baked into the repo and
 * replayed OFFLINE.
 *
 * A forked anvil fetches state lazily: only the accounts and storage slots
 * something actually touched are in memory, and only those end up in a state
 * dump. So this script exercises every path the offline chain must serve —
 * the PostageStamp reads and writes, the BZZ token, and SushiSwap across a
 * range of trade sizes (a swap only warms the ticks it crosses, and a later
 * trade of a different size would reach for slots that were never fetched).
 *
 * A state dump only carries accounts anvil considers dirty, so contracts that
 * were merely READ — the SushiSwap quoter — are missing from it. Those are
 * merged back in afterwards by `mergeReadOnlyContracts`, which is why this
 * script also needs the upstream RPC.
 *
 * Usage (see multichain/README.md):
 *   pnpm dev:fork:bake         # starts the fork, runs this, writes the fixture
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { MultichainClient, gnosisMainnetSettings } from "../src/index"
import { anvilSetBalance, simulateWidgetPurchase } from "../src/dev"

const RPC_URL = process.env.FORK_RPC_URL ?? "http://localhost:8545"
/** Where the dump lands, and the upstream used to fill in read-only code. */
const UPSTREAM_RPC_URL =
  process.env.GNOSIS_RPC_URL ?? "https://rpc.gnosischain.com"
const XDAI = 10n ** 18n

/**
 * Swap sizes to warm, in xDAI. The tests and the dev UI use 0.05; the others
 * bracket it so a slightly different amount still finds its ticks cached.
 */
const SWAP_SIZES = [XDAI / 100n, XDAI / 20n, XDAI / 10n, XDAI / 4n, XDAI]

const DEPTH = 17
const NEW_DEPTH = 18
const FLOOR_MULTIPLE = 4n
const PAYER_XDAI = 2n * XDAI

async function main(): Promise<void> {
  const settings = gnosisMainnetSettings({ rpcUrls: [RPC_URL] })
  const client = new MultichainClient(settings)

  const chainId = await client.getChainId()
  if (chainId !== settings.chainId) {
    throw new Error(
      `Expected a Gnosis fork at ${RPC_URL}, got chain id ${chainId}.`,
    )
  }

  const constraints = await client.getPostageWriteConstraints()
  console.log(
    `chain ${chainId} · price ${constraints.lastPrice} · minimum ${constraints.minimumInitialBalancePerChunk}`,
  )

  // SushiSwap: quote and execute across the range, warming the pool's ticks.
  for (const amountXdai of SWAP_SIZES) {
    const key = generatePrivateKey()
    const trader = privateKeyToAccount(key).address
    await anvilSetBalance(RPC_URL, trader, amountXdai + XDAI)
    const quoted = await client.quoteBzzOutForXdaiIn(amountXdai)
    await client.quoteXdaiInForBzzOut(quoted)
    const hash = await client.swapXdaiToBzz({
      originPrivateKey: key,
      amountXdai,
      recipient: trader,
    })
    await client.waitForTransactionSuccess(hash)
    console.log(`swapped ${amountXdai} wei xDAI → ${quoted} PLUR BZZ`)
  }

  // The whole purchase path, which also warms approve/transfer and the
  // PostageStamp's batch storage.
  const ownerKey = generatePrivateKey()
  const owner = privateKeyToAccount(ownerKey).address
  const amountPerChunk =
    constraints.minimumInitialBalancePerChunk * FLOOR_MULTIPLE
  const purchase = await simulateWidgetPurchase(
    {
      owner,
      depth: DEPTH,
      amountPerChunk,
      payerPrivateKey: generatePrivateKey(),
      payerXdai: PAYER_XDAI,
      swapXdai: XDAI / 20n,
    },
    settings,
  )
  console.log(`created batch ${purchase.batchId} owned by ${owner}`)

  // ...and the owner-signed operations the product performs.
  const total = constraints.minimumInitialBalancePerChunk << BigInt(DEPTH)
  const approveHash = await client.approveBzz({
    amount: total,
    originPrivateKey: ownerKey,
    spender: settings.addresses.postageStamp,
  })
  await client.waitForTransactionSuccess(approveHash)
  const topUpHash = await client.topUpBatch({
    originPrivateKey: ownerKey,
    batchId: purchase.batchId,
    amountPerChunk: constraints.minimumInitialBalancePerChunk,
  })
  await client.waitForTransactionSuccess(topUpHash)
  const depthHash = await client.increaseDepth({
    originPrivateKey: ownerKey,
    batchId: purchase.batchId,
    newDepth: NEW_DEPTH,
  })
  await client.waitForTransactionSuccess(depthHash)
  console.log(`topped up and resized to depth ${NEW_DEPTH}`)

  console.log("\nWarm. Stop the fork to write its state dump.")
}

/**
 * Contracts the flows only ever CALL. Anvil drops them from a state dump —
 * nothing wrote to them — so an offline replay would find no code there.
 */
export const READ_ONLY_CONTRACTS: `0x${string}`[] = [
  "0xb1E835Dc2785b52265711e17fCCb0fd018226a6e", // SushiSwap V3 quoter
]

/** Fetch `eth_getCode` for each read-only contract and splice it into a dump. */
export async function mergeReadOnlyContracts(
  statePath: string,
  upstreamRpcUrl: string = UPSTREAM_RPC_URL,
): Promise<void> {
  const { readFile, writeFile } = await import("node:fs/promises")
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    accounts: Record<string, unknown>
  }
  for (const address of READ_ONLY_CONTRACTS) {
    const response = await fetch(upstreamRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: [address, "latest"],
      }),
    })
    const { result } = (await response.json()) as { result?: string }
    if (!result || result === "0x") {
      throw new Error(`No code at ${address} on ${upstreamRpcUrl}`)
    }
    state.accounts[address.toLowerCase()] = {
      nonce: 1,
      balance: "0x0",
      code: result,
      storage: {},
    }
    console.log(`merged read-only code for ${address}`)
  }
  await writeFile(statePath, JSON.stringify(state))
}

const mergeOnly = process.argv.includes("--merge-only")
if (mergeOnly) {
  const statePath = process.argv[process.argv.indexOf("--merge-only") + 1]
  if (!statePath) {
    throw new Error("--merge-only requires a path to the state dump")
  }
  await mergeReadOnlyContracts(statePath)
} else {
  await main()
}

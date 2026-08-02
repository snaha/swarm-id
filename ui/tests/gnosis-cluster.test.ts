// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The two halves of the local setup, joined: a batch bought through the
 * multichain path is one the local Bee cluster actually knows about, and can
 * actually be uploaded with.
 *
 *   swap on the real SushiSwap pool → createBatch on the PostageStamp
 *   → the node ingests that event into its batch store, owner and all
 *   → a chunk stamped client-side by the owner uploads and reads back
 *
 * This is what bee-compose's hybrid chain buys: the DEX and BZZ come from a
 * Gnosis mainnet fork, the Swarm contracts are deployed from source on top at
 * their mainnet addresses, so the nodes follow the same PostageStamp the
 * purchase went through. See vendor/bee-compose/blockchain/HYBRID-CHAIN.md.
 *
 * Start it with `pnpm dev:bee:detach`; skipped when it is down. The upload
 * needs a peer to pushsync a receipt from, so run with workers
 * (`pnpm dev:bee:detach` brings up four full nodes).
 */
import { Bee, MerkleTree, Stamper } from '@ethersphere/bee-js'
import { expect, test } from '@playwright/test'
import { gnosisMainnetSettings } from '@swarm-id/multichain'
import { simulateWidgetPurchase } from '@swarm-id/multichain/dev'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const CHAIN_RPC_URL = process.env.CHAIN_RPC_URL ?? 'http://localhost:9545'
const BEE_URL = 'http://localhost:1633'
const PROBE_TIMEOUT_MS = 2000
/** Bee polls the postage contract on a ~25s cycle; leave room for a few. */
const INGEST_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 5000
const XDAI = 10n ** 18n
const DEPTH = 20
const FLOOR_MULTIPLE = 3n
const PAYER_XDAI = 2n * XDAI
/**
 * Generous next to what a batch costs, so the swap leg is exercised for real
 * — but still small: the cluster's chain is long-lived and every purchase
 * moves the real (thin) BZZ pool a little.
 */
const SWAP_XDAI = XDAI / 4n

async function reachable(url: string, init?: RequestInit): Promise<boolean> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return response.ok
  } catch {
    return false
  }
}

const clusterUp =
  (await reachable(CHAIN_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  })) && (await reachable(`${BEE_URL}/health`))

interface KnownBatch {
  batchID: string
  owner: string
  depth: number
}

async function knownBatches(): Promise<KnownBatch[]> {
  const response = await fetch(`${BEE_URL}/batches`)
  return ((await response.json()) as { batches?: KnownBatch[] }).batches ?? []
}

async function peerCount(): Promise<number> {
  const response = await fetch(`${BEE_URL}/peers`)
  return ((await response.json()) as { peers?: unknown[] }).peers?.length ?? 0
}

/** The whole purchase, exactly as the widget arranges it in production. */
async function buyBatch(): Promise<{ batchId: `0x${string}`; ownerKey: `0x${string}` }> {
  const settings = gnosisMainnetSettings({ rpcUrls: [CHAIN_RPC_URL] })

  // The account's postage signer owns the batch and a throwaway wallet pays.
  const ownerKey = generatePrivateKey()
  const owner = privateKeyToAccount(ownerKey).address

  const minimumResponse = await fetch(CHAIN_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      // minimumInitialBalancePerChunk()
      method: 'eth_call',
      params: [{ to: settings.addresses.postageStamp, data: '0x90697842' }, 'latest'],
    }),
  })
  const minimum = BigInt(((await minimumResponse.json()) as { result: string }).result)

  const purchase = await simulateWidgetPurchase(
    {
      owner,
      depth: DEPTH,
      amountPerChunk: minimum * FLOOR_MULTIPLE,
      payerPrivateKey: generatePrivateKey(),
      payerXdai: PAYER_XDAI,
      swapXdai: SWAP_XDAI,
    },
    settings,
  )
  return { batchId: purchase.batchId, ownerKey }
}

/** Wait for the node to see the batch on chain, as it only learns by watching. */
async function waitForIngestion(batchId: `0x${string}`): Promise<KnownBatch | undefined> {
  const wanted = batchId.slice(2).toLowerCase()
  const deadline = Date.now() + INGEST_TIMEOUT_MS
  while (Date.now() < deadline) {
    const found = (await knownBatches()).find((batch) => batch.batchID.toLowerCase() === wanted)
    if (found) {
      return found
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return undefined
}

test.skip(!clusterUp, 'requires the bee-compose cluster (pnpm dev:bee:detach)')

test('the node ingests a batch bought through the multichain path', async () => {
  test.setTimeout(INGEST_TIMEOUT_MS * 2)
  const { batchId, ownerKey } = await buyBatch()
  const owner = privateKeyToAccount(ownerKey).address

  const ingested = await waitForIngestion(batchId)
  expect(ingested, `node never ingested ${batchId} from the PostageStamp`).toBeDefined()
  // ...and it records the account's signer as the owner, not the payer.
  expect(ingested!.owner.toLowerCase()).toBe(owner.slice(2).toLowerCase())
  expect(ingested!.depth).toBe(DEPTH)
})

test('a chunk stamped client-side by the batch owner uploads and reads back', async () => {
  test.setTimeout(INGEST_TIMEOUT_MS * 2)
  // A non-deferred upload only returns once the chunk is pushsynced to a peer,
  // which a lone queen cannot do.
  test.skip((await peerCount()) === 0, 'needs peers — start workers')

  const { batchId, ownerKey } = await buyBatch()
  expect(await waitForIngestion(batchId), `node never ingested ${batchId}`).toBeDefined()

  // The batch owner signs the stamp itself and the node only ever sees a signed
  // envelope — the point of the key hierarchy is that the node is never trusted
  // with the owner key.
  const stamper = Stamper.fromBlank(ownerKey, batchId, DEPTH)
  const payload = new TextEncoder().encode(`hybrid chain ${crypto.randomUUID()}`)
  const chunk = await MerkleTree.root(payload)

  const bee = new Bee(BEE_URL)
  const uploaded = await bee.uploadChunk(stamper.stamp(chunk), chunk.build(), { deferred: false })
  const stored = await bee.downloadChunk(uploaded.reference)

  // A content-addressed chunk is `span (8 bytes) || payload`, zero-padded to
  // the full 4096; the span is what says where the payload ends.
  const span = Number(new DataView(stored.buffer, stored.byteOffset, 8).getBigUint64(0, true))
  expect(span).toBe(payload.length)
  expect(new TextDecoder().decode(stored.slice(8, 8 + span))).toBe(
    new TextDecoder().decode(payload),
  )
})

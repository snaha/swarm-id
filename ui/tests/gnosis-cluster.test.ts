// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The two halves of the local setup, joined: a batch bought through the
 * multichain path is one the local Bee node actually knows about.
 *
 * bee-compose's nodes follow their own chain with their own PostageStamp
 * deployment, so a batch created on Gnosis is invisible to them — the node
 * never sees its BatchCreated event and refuses the stamp. The cluster under
 * `dev/gnosis-cluster` points Bee at the baked Gnosis chain instead, and this
 * is the proof that closes the loop:
 *
 *   swap on the real SushiSwap pool → createBatch on the real PostageStamp
 *   → the node ingests that event into its batch store, owner and all
 *
 * Uploading with the batch needs peers to pushsync a receipt from, which a
 * single-node cluster cannot do (see .claude/rules/bee-cluster.md); that
 * arrives with the worker fleet when this moves into bee-compose.
 *
 * Start the cluster with `pnpm dev:gnosis:detach`; skipped when it is down.
 */
import { expect, test } from '@playwright/test'
import { gnosisMainnetSettings } from '@swarm-id/multichain'
import { simulateWidgetPurchase } from '@swarm-id/multichain/dev'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const CHAIN_RPC_URL = 'http://localhost:8545'
const BEE_URL = 'http://localhost:1633'
const PROBE_TIMEOUT_MS = 2000
/** Bee polls the postage contract on a ~25s cycle; leave room for a few. */
const INGEST_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 5000
const XDAI = 10n ** 18n
const DEPTH = 20
const FLOOR_MULTIPLE = 3n

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

test.skip(!clusterUp, 'requires the Gnosis cluster (pnpm dev:gnosis:detach)')

test('the node ingests a batch bought through the multichain path', async () => {
  test.setTimeout(INGEST_TIMEOUT_MS * 2)
  const settings = gnosisMainnetSettings({ rpcUrls: [CHAIN_RPC_URL] })

  // The account's postage signer owns the batch and a throwaway wallet pays,
  // exactly as the widget arranges it in production.
  const ownerKey = generatePrivateKey()
  const owner = privateKeyToAccount(ownerKey).address

  const minimumResponse = await fetch(CHAIN_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      // minimumInitialBalancePerChunk()
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
      payerXdai: 2n * XDAI,
      // Generous: the cluster's chain is long-lived, so every purchase moves
      // the real (thin) BZZ pool a little and later runs fill worse.
      swapXdai: XDAI / 4n,
    },
    settings,
  )
  const batchId = purchase.batchId.slice(2).toLowerCase()

  // The node learns about it only by watching the contract we bought from.
  const deadline = Date.now() + INGEST_TIMEOUT_MS
  let ingested: KnownBatch | undefined
  while (!ingested && Date.now() < deadline) {
    ingested = (await knownBatches()).find((batch) => batch.batchID.toLowerCase() === batchId)
    if (!ingested) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  }

  expect(ingested, `node never ingested ${batchId} from the Gnosis PostageStamp`).toBeDefined()
  // ...and it records the account's signer as the owner, not the payer.
  expect(ingested!.owner.toLowerCase()).toBe(owner.slice(2).toLowerCase())
  expect(ingested!.depth).toBe(DEPTH)
})

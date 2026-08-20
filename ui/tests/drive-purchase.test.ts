// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Buying a drive must produce a REAL batch on chain that the account owns —
 * otherwise the drive has nothing behind it and extend / resize cannot read it.
 *
 * A purchase runs through the same on-chain engine as extend and resize, so
 * there is nothing simulated to check here — only that it lands where it says
 * it does.
 */
import { PrivateKey } from '@ethersphere/bee-js'
import { type Page, expect, test } from '@playwright/test'
import { gnosisMainnetSettings } from '@swarm-id/multichain'

import {
  CHAIN_RPC_URL,
  addDrive,
  chainReachable,
  completeCreateFlow,
  confirmPurchased,
  fundPostageSigner,
} from './helpers'

const ANVIL_RPC_URL = CHAIN_RPC_URL
const BEE_NODE_URL = 'http://localhost:1633/'
const ONCHAIN_TIMEOUT_MS = 120_000
/** The deployment the app itself resolves — the local chain carries it too. */
const POSTAGE_STAMP = gnosisMainnetSettings().addresses.postageStamp
const BATCHES_SELECTOR = '0xc81e25ab'
const ZERO_ADDRESS_WORD = '0'.repeat(64)

const chainUp = await chainReachable()

/** The batch's on-chain owner, or undefined when the contract has no such batch. */
async function onChainOwner(batchId: string): Promise<string | undefined> {
  const response = await fetch(ANVIL_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: POSTAGE_STAMP, data: `${BATCHES_SELECTOR}${batchId}` }, 'latest'],
    }),
  })
  const { result } = (await response.json()) as { result?: string }
  const owner = result?.slice(2, 2 + 64)
  return !owner || owner === ZERO_ADDRESS_WORD ? undefined : `0x${owner.slice(24)}`
}

function storedDrive(page: Page) {
  return page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: {
        postageStamps?: { batchID: string; depth: number; signerKey: string }[]
      }[]
    }
    const stamp = doc.data?.[0]?.postageStamps?.[0]
    return stamp
      ? { batchID: stamp.batchID, depth: stamp.depth, signerKey: stamp.signerKey }
      : undefined
  })
}

// A real purchase spans several 5s blocks; the 30s default is not enough.
test.setTimeout(180_000)

test.skip(
  !chainUp,
  'requires the bee-compose chain (pnpm dev:cluster:start, or pnpm dev:chain:detach)',
)

test('buying a drive creates a batch the account owns on chain', async ({ page }) => {
  test.setTimeout(ONCHAIN_TIMEOUT_MS * 2)
  await page.addInitScript(
    ([rpcUrl, beeUrl]) => {
      localStorage.setItem(
        'swarm-id-network-settings',
        JSON.stringify({ beeNodeUrl: beeUrl, gnosisRpcUrl: rpcUrl }),
      )
    },
    [ANVIL_RPC_URL, BEE_NODE_URL],
  )

  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()

  await fundPostageSigner(page)
  await addDrive(page)
  // Settling for real takes chain time: approve + createBatch, then reading the
  // batch back. It ends on the success screen, which has to be acknowledged
  // before the drive list is reachable again.
  await confirmPurchased(page)
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible()

  const drive = await storedDrive(page)
  expect(drive).toBeDefined()

  // The purchased batch exists on chain and is owned by the account's signer,
  // not by whoever paid — the production role split.
  const owner = await onChainOwner(drive!.batchID)
  expect(owner).toBeDefined()

  const signerAddress = new PrivateKey(drive!.signerKey).publicKey().address().toHex()
  expect(owner!.toLowerCase()).toBe(`0x${signerAddress}`.toLowerCase())

  // And because it is a real batch, the paid flows work on it straight away.
  await page.getByRole('button', { name: 'Expand drive' }).click()
  await page.getByRole('button', { name: 'Extend lifespan' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').selectOption('days')
  await dialog.getByRole('button', { name: 'Increase' }).click()
  await dialog.getByRole('button', { name: 'Proceed' }).click()
  await expect(page.getByText('lifespan has been extended')).toBeVisible({
    timeout: ONCHAIN_TIMEOUT_MS,
  })
})

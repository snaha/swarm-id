// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Buying a drive must produce a REAL batch on chain that the account owns —
 * otherwise the drive has nothing behind it and extend / resize cannot read it.
 *
 * This used to assert that a *simulated* purchase did so, because buying went
 * through an external popup that could not complete off mainnet. It no longer
 * does: the purchase runs through the same on-chain engine as extend and
 * resize, so there is nothing simulated left to check — only that a purchase
 * lands where it says it does.
 */
import { PrivateKey } from '@ethersphere/bee-js'
import { type Page, expect, test } from '@playwright/test'

import { addDrive, completeCreateFlow, pinNoPaymentRail } from './helpers'

const ANVIL_RPC_URL = process.env.CHAIN_RPC_URL ?? 'http://localhost:9545'
const BEE_NODE_URL = 'http://localhost:1633/'
const ONCHAIN_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 2000
const LOCAL_POSTAGE_STAMP = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512'
const GNOSIS_POSTAGE_STAMP = '0x45a1502382541Cd610CC9068e88727426b696293'
const GNOSIS_CHAIN_ID = 100
const BATCHES_SELECTOR = '0xc81e25ab'
const ZERO_ADDRESS_WORD = '0'.repeat(64)

async function anvilReachable(): Promise<boolean> {
  try {
    const response = await fetch(ANVIL_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return typeof ((await response.json()) as { result?: string }).result === 'string'
  } catch {
    return false
  }
}

const chainUp = await anvilReachable()

async function chainId(): Promise<number> {
  const response = await fetch(ANVIL_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  })
  return Number(BigInt(((await response.json()) as { result: string }).result))
}

/**
 * The batch's on-chain owner, or undefined when the contract has no such
 * batch. Which PostageStamp to ask follows the chain: a Gnosis chain (the
 * bee-compose cluster) carries the mainnet deployment.
 */
async function onChainOwner(batchId: string): Promise<string | undefined> {
  const postageStamp =
    (await chainId()) === GNOSIS_CHAIN_ID ? GNOSIS_POSTAGE_STAMP : LOCAL_POSTAGE_STAMP
  const response = await fetch(ANVIL_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: postageStamp, data: `${BATCHES_SELECTOR}${batchId}` }, 'latest'],
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

test.beforeEach(({ page }) => pinNoPaymentRail(page))
// A real purchase spans several 5s blocks; the 30s default is not enough.
test.setTimeout(180_000)

test.skip(!chainUp, 'requires the bee-compose chain (pnpm dev:local)')

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

  await addDrive(page)
  // Settling for real takes chain time (create + fund + receipt), unlike the
  // fabricated fallback the chainless suites see.
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible({
    timeout: ONCHAIN_TIMEOUT_MS,
  })

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
  await expect(page.getByText('Lifespan extended')).toBeVisible({ timeout: ONCHAIN_TIMEOUT_MS })
})

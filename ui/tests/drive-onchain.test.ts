// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Extend and resize executed as REAL transactions against the bee-compose
 * anvil chain, signed by the account's derived postage signer — no Bee node
 * involved. Funding is mocked at its seam (the queen faucet stands in for
 * Relay + the DEX, neither of which exists locally).
 *
 * Skipped automatically when the local chain is unreachable, so the suite
 * never breaks a run without the cluster.
 */
import { type Page, expect, test } from '@playwright/test'
import { gnosisMainnetSettings } from '@swarm-id/multichain'
import { devRpc } from '@swarm-id/multichain/dev'

import { completeCreateFlow } from './helpers'

// Defaults to the bee-compose cluster's chain; set CHAIN_RPC_URL=http://localhost:8545
// to run the identical suite against the same snapshot standalone
// (`pnpm dev:chain`).
const ANVIL_RPC_URL = process.env.CHAIN_RPC_URL ?? 'http://localhost:9545'
const BEE_NODE_URL = 'http://localhost:1633/'
/** On-chain work spans several 5s-block confirmations. */
const ONCHAIN_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 2000

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

/** The EIP-7702 delegate, from the settings the app itself resolves. */
const DELEGATE_ADDRESS = gnosisMainnetSettings().addresses.eip7702Delegate

const delegateCode = () =>
  devRpc(ANVIL_RPC_URL, 'eth_getCode', [DELEGATE_ADDRESS, 'latest']).then(String)
const setDelegateCode = (code: string) =>
  devRpc(ANVIL_RPC_URL, 'anvil_setCode', [DELEGATE_ADDRESS, code])

/**
 * Put the delegate back exactly as it was, so a suite ordering change cannot
 * leave later tests silently exercising the fallback instead of the real path.
 */
let savedDelegateCode = ''
const restoreDelegate = () => setDelegateCode(savedDelegateCode)

/** The stored drive's on-chain-relevant fields. */
function storedDrive(page: Page) {
  return page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: { postageStamps?: { depth: number; amount: string; batchTTL?: number }[] }[]
    }
    const stamp = doc.data?.[0]?.postageStamps?.[0]
    return stamp
      ? { depth: stamp.depth, amount: BigInt(stamp.amount).toString(), ttl: stamp.batchTTL ?? 0 }
      : undefined
  })
}

/**
 * Create an account, point it at the local chain, and give it a drive whose
 * batch the account's own signer owns on chain (the /dev action mirrors
 * production: the payment machinery creates the batch, the derived signer
 * owns it).
 */
async function createAccountWithOnChainDrive(page: Page) {
  await page.addInitScript(
    ([rpcUrl, beeUrl]) => {
      localStorage.setItem(
        'swarm-id-network-settings',
        JSON.stringify({ beeNodeUrl: beeUrl, gnosisRpcUrl: rpcUrl }),
      )
      // Mock funding: the dev chain has no Relay and no DEX, so the drive
    },
    [ANVIL_RPC_URL, BEE_NODE_URL],
  )

  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()

  await page.goto('/dev')
  await page.getByRole('tab', { name: 'Chain' }).click()
  // One action rather than create-batch → copy id → copy signer key → paste →
  // import. It is also the path the README tells a newcomer to use, so this
  // keeps that instruction honest.
  await page.getByRole('button', { name: 'Create drive to test with' }).click()
  await expect(page.getByText(/^Created drive: 0x[0-9a-f]{64}$/)).toBeVisible({
    timeout: ONCHAIN_TIMEOUT_MS,
  })
  await expect
    .poll(async () => (await storedDrive(page))?.depth, { timeout: ONCHAIN_TIMEOUT_MS })
    .toBe(20)

  await page.goto('/')
  await page.getByRole('tab', { name: 'Storage' }).click()
  await page.getByRole('button', { name: 'Expand drive' }).click()
}

test.describe.configure({ mode: 'serial' })

test.skip(!chainUp, 'requires a local chain (pnpm dev:local, or pnpm dev:chain:detach)')

test.beforeAll(async () => {
  if (chainUp) {
    savedDelegateCode = await delegateCode()
  }
})

// These used to snapshot/revert around each test to conserve the BZZ pool. They
// must NOT: a Bee node following this chain records the block it has processed
// and never re-scans below it, so rewinding under a running cluster desyncs it
// permanently — it stops ingesting, and only a volume reset recovers it. The
// cost of not rewinding is now small anyway: a purchase swaps 0.25 xDAI against
// ~50 xDAI of warmed range, and `pnpm bake` resets the pool outright.

test('extend tops the batch up on chain and records the longer lifespan', async ({ page }) => {
  test.setTimeout(ONCHAIN_TIMEOUT_MS * 2)
  await createAccountWithOnChainDrive(page)
  const before = await storedDrive(page)

  await page.getByRole('button', { name: 'Extend lifespan' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').selectOption('days')
  await dialog.getByRole('button', { name: 'Increase' }).click()
  await dialog.getByRole('button', { name: 'Proceed' }).click()

  await expect(page.getByText('Lifespan extended')).toBeVisible({ timeout: ONCHAIN_TIMEOUT_MS })
  const after = await storedDrive(page)
  expect(BigInt(after!.amount)).toBeGreaterThan(BigInt(before!.amount))
  expect(after!.ttl).toBeGreaterThan(before!.ttl)
  // A top-up never changes capacity.
  expect(after!.depth).toBe(before!.depth)
})

/**
 * The sequential path is only reachable where the EIP-7702 delegate is absent —
 * which, since every dev flow installs it, is nowhere by default. Without this
 * test the fallback and its whole partial-failure treatment could rot unnoticed
 * while the bundled path stayed green.
 */
test('extends without the 7702 delegate, one transaction at a time', async ({ page }) => {
  test.setTimeout(ONCHAIN_TIMEOUT_MS * 2)
  await createAccountWithOnChainDrive(page)
  const before = await storedDrive(page)

  // After setup, so the batch creation that installs it has already run.
  await setDelegateCode('0x')
  try {
    expect(await delegateCode()).toBe('0x')

    await page.getByRole('button', { name: 'Extend lifespan' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('combobox').selectOption('days')
    await dialog.getByRole('button', { name: 'Increase' }).click()
    await dialog.getByRole('button', { name: 'Proceed' }).click()

    await expect(page.getByText('Lifespan extended')).toBeVisible({ timeout: ONCHAIN_TIMEOUT_MS })
  } finally {
    await restoreDelegate()
  }

  const after = await storedDrive(page)
  expect(BigInt(after!.amount)).toBeGreaterThan(BigInt(before!.amount))
  expect(after!.ttl).toBeGreaterThan(before!.ttl)
  expect(after!.depth).toBe(before!.depth)
})

test('resize keeps the lifespan by topping up BEFORE increasing the depth', async ({ page }) => {
  test.setTimeout(ONCHAIN_TIMEOUT_MS * 2)
  await createAccountWithOnChainDrive(page)
  const before = await storedDrive(page)

  await page.getByRole('button', { name: 'Increase size' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').selectOption('21')
  await dialog.getByRole('button', { name: 'Proceed' }).click()

  await expect(page.getByText('Drive size increased')).toBeVisible({ timeout: ONCHAIN_TIMEOUT_MS })
  const after = await storedDrive(page)
  expect(after!.depth).toBe(21)
  // Keep-lifespan holds the remaining time across the doubling (a few seconds
  // of block-time drift is expected, so compare with tolerance).
  const DRIFT_TOLERANCE_SECONDS = 600
  expect(Math.abs(after!.ttl - before!.ttl)).toBeLessThan(DRIFT_TOLERANCE_SECONDS)
})

test('an interrupted resize resumes from chain truth without paying twice', async ({ page }) => {
  test.setTimeout(ONCHAIN_TIMEOUT_MS * 3)
  await createAccountWithOnChainDrive(page)

  await page.getByRole('button', { name: 'Increase size' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').selectOption('21')
  await dialog.getByRole('button', { name: 'Proceed' }).click()
  await expect(page.getByText('Drive size increased')).toBeVisible({ timeout: ONCHAIN_TIMEOUT_MS })

  // Simulate a session lost between the on-chain resize and its record: roll
  // the local record back to the pre-resize state the chain has moved past.
  await page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: { postageStamps?: { depth: number; amount: string; batchTTL?: number }[] }[]
    }
    const stamp = doc.data?.[0]?.postageStamps?.[0]
    if (stamp) {
      stamp.depth = 20
      stamp.amount = '1'
      stamp.batchTTL = 60
    }
    localStorage.setItem('swarm-id-accounts', JSON.stringify(doc))
  })
  await page.reload()
  await page.getByRole('tab', { name: 'Storage' }).click()
  await page.getByRole('button', { name: 'Expand drive' }).click()

  // Re-running the same resize must detect the landed increase and reconcile,
  // never send a second transaction or ask for another payment.
  await page.getByRole('button', { name: 'Increase size' }).click()
  const retry = page.getByRole('dialog')
  await retry.getByRole('combobox').selectOption('21')
  await retry.getByRole('button', { name: 'Proceed' }).click()

  await expect(page.getByText('Drive size increased')).toBeVisible({ timeout: ONCHAIN_TIMEOUT_MS })
  const after = await storedDrive(page)
  expect(after!.depth).toBe(21)
  // The rolled-back placeholders are gone — the record came from the chain.
  expect(BigInt(after!.amount)).toBeGreaterThan(1n)
  expect(after!.ttl).toBeGreaterThan(60)
})

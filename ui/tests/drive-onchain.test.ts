// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Extend and resize executed as REAL transactions against the bee-compose
 * anvil chain, signed by the account's derived postage signer — no Bee node
 * involved. The drive they operate on is bought for real too: `/dev`'s
 * Create-drive action swaps, approves and calls `createBatch` on chain, faking
 * only the cross-chain leg (the payer's xDAI is minted rather than bridged),
 * and hands its leftover BZZ and xDAI to the owner. So the signer is already
 * funded when it extends, and no payment screen opens.
 *
 * Skipped automatically when the local chain is unreachable, so the suite
 * never breaks a run without the cluster.
 */
import { type Page, expect, test } from '@playwright/test'
import { gnosisMainnetSettings } from '@swarm-id/multichain'
import { devRpc, ensureBundlingDelegate } from '@swarm-id/multichain/dev'

import { CHAIN_RPC_URL, chainReachable, completeCreateFlow } from './helpers'

// Defaults to the bee-compose cluster's chain; set CHAIN_RPC_URL
// to run the identical suite against the same snapshot standalone
// (`pnpm dev:chain`).
const ANVIL_RPC_URL = CHAIN_RPC_URL
const BEE_NODE_URL = 'http://localhost:1633/'
/** On-chain work spans several 5s-block confirmations. */
const ONCHAIN_TIMEOUT_MS = 120_000
/** A cold dev server compiling a heavy route, not a chain wait. */
const PAGE_READY_TIMEOUT_MS = 30_000

const chainUp = await chainReachable()

/** The chain this suite mutates, and the delegate address the app resolves. */
const SETTINGS = gnosisMainnetSettings({ rpcUrls: [ANVIL_RPC_URL] })
const DELEGATE_ADDRESS = SETTINGS.addresses.eip7702Delegate

const delegateCode = () =>
  devRpc(ANVIL_RPC_URL, 'eth_getCode', [DELEGATE_ADDRESS, 'latest']).then(String)
const clearDelegate = () => devRpc(ANVIL_RPC_URL, 'anvil_setCode', [DELEGATE_ADDRESS, '0x'])

/**
 * Put the delegate back from the canonical bytecode, NOT from a snapshot taken
 * at startup.
 *
 * The dev chain is long-lived and shared, and this suite deliberately breaks
 * it. A snapshot restores the wrong thing in exactly the case that matters: a
 * worker that crashed between the wipe and the restore leaves a chain with no
 * delegate, and the next run snapshots THAT as "the original" and faithfully
 * puts it back. `ensureBundlingDelegate` is idempotent and knows what the
 * delegate should be, so every path — including a crashed one — converges on a
 * working chain.
 */
const restoreDelegate = () => ensureBundlingDelegate(SETTINGS)

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
    },
    [ANVIL_RPC_URL, BEE_NODE_URL],
  )

  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()

  await page.goto('/dev')
  // /dev is by far the heaviest route, and on a cold dev server its first paint
  // routinely outlasts the 5s action timeout — a failure about a missing tab
  // that is really about compilation. Wait for it to exist before clicking it.
  const chainTab = page.getByRole('tab', { name: 'Chain' })
  await expect(chainTab).toBeVisible({ timeout: PAGE_READY_TIMEOUT_MS })
  await chainTab.click()
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

test.skip(!chainUp, 'requires a local chain (pnpm dev:cluster:start, or pnpm dev:chain:detach)')

// Start from a chain that can bundle, whatever an earlier crashed run left
// behind — a no-op when the delegate is already there, which is the normal case.
test.beforeAll(async () => {
  if (chainUp) {
    await restoreDelegate()
  }
})

// These must NOT snapshot/revert around each test to conserve the BZZ pool: a
// Bee node following this chain records the block it has processed and never
// re-scans below it, so rewinding under a running cluster desyncs it
// permanently — it stops ingesting, and only a volume reset recovers it. The
// cost of not rewinding is small: a purchase swaps 0.25 xDAI against
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

  await expect(page.getByText('lifespan has been extended')).toBeVisible({
    timeout: ONCHAIN_TIMEOUT_MS,
  })
  const after = await storedDrive(page)
  expect(BigInt(after!.amount)).toBeGreaterThan(BigInt(before!.amount))
  expect(after!.ttl).toBeGreaterThan(before!.ttl)
  // A top-up never changes capacity.
  expect(after!.depth).toBe(before!.depth)
})

/**
 * With no sequential fallback, a chain missing the delegate must REFUSE — and
 * refuse before charging anything. The failure mode this replaces was worse
 * than an error: the same work in separate transactions, with a seam in the
 * middle that could leave a drive paid for and half-resized (#541).
 */
test('refuses to operate on a chain without the 7702 delegate', async ({ page }) => {
  test.setTimeout(ONCHAIN_TIMEOUT_MS * 2)
  await createAccountWithOnChainDrive(page)
  const before = await storedDrive(page)

  // After setup, so the batch creation that installs it has already run.
  await clearDelegate()
  try {
    expect(await delegateCode()).toBe('0x')

    await page.getByRole('button', { name: 'Extend lifespan' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('combobox').selectOption('days')
    await dialog.getByRole('button', { name: 'Increase' }).click()
    await dialog.getByRole('button', { name: 'Proceed' }).click()

    await expect(page.getByText('single transaction')).toBeVisible({
      timeout: ONCHAIN_TIMEOUT_MS,
    })
  } finally {
    await restoreDelegate()
  }
  expect(await delegateCode()).not.toBe('0x')

  // Refused, not half-done: the drive is exactly as it was.
  const after = await storedDrive(page)
  expect(after!.amount).toBe(before!.amount)
  expect(after!.ttl).toBe(before!.ttl)
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

  await expect(page.getByText('Your drive is now larger')).toBeVisible({
    timeout: ONCHAIN_TIMEOUT_MS,
  })
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
  await expect(page.getByText('Your drive is now larger')).toBeVisible({
    timeout: ONCHAIN_TIMEOUT_MS,
  })

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

  await expect(page.getByText('Your drive is now larger')).toBeVisible({
    timeout: ONCHAIN_TIMEOUT_MS,
  })
  const after = await storedDrive(page)
  expect(after!.depth).toBe(21)
  // The rolled-back placeholders are gone — the record came from the chain.
  expect(BigInt(after!.amount)).toBeGreaterThan(1n)
  expect(after!.ttl).toBeGreaterThan(60)
})

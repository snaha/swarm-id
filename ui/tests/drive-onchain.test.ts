// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Extend and resize executed as REAL transactions against the bee-compose
 * anvil chain, signed by the account's derived postage signer — no Bee node
 * involved. Nothing about the funding is mocked either: the drive is made with
 * `/dev`'s Create-drive action, a real purchase on the local chain that leaves
 * its leftover BZZ and xDAI with the owner, so the signer is already funded
 * when it extends and no payment is owed.
 *
 * Everything here READS the chain's shared state and writes only its own
 * account's. The one case that has to remove the EIP-7702 delegate — which
 * every worker on the chain shares — is `drive-onchain-serial.test.ts`.
 *
 * Skipped automatically when the local chain is unreachable, so the suite
 * never breaks a run without the cluster.
 */
import { expect, test } from '@playwright/test'

import {
  ONCHAIN_TIMEOUT_MS,
  chainUp,
  createAccountWithOnChainDrive,
  storedDrive,
} from './drive-onchain-setup'

test.describe.configure({ mode: 'serial' })

test.skip(!chainUp, 'requires a local chain (pnpm dev:local, or pnpm dev:chain:detach)')

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

  // Opening the dialog reconciles: the record catches up to the landed
  // increase, and the size list starts at the drive's real size — there is no
  // stale option left to re-run the resize through, and no payment to take.
  await page.getByRole('button', { name: 'Increase size' }).click()
  const retry = page.getByRole('dialog')
  await expect(retry.locator('option[value="21"]')).toHaveCount(0, {
    timeout: ONCHAIN_TIMEOUT_MS,
  })
  await expect(page.getByText('Pay with crypto')).toHaveCount(0)

  await expect.poll(async () => (await storedDrive(page))?.depth).toBe(21)
  const after = await storedDrive(page)
  // The rolled-back placeholders are gone — the record came from the chain.
  expect(BigInt(after!.amount)).toBeGreaterThan(1n)
  expect(after!.ttl).toBeGreaterThan(60)
})

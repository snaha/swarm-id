// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The "Pay with crypto" widget method, driven through the /dev mock.
 *
 * Deliberately CHAIN-FREE — that is the whole point. The real widget only
 * settles on mainnet, so the only way to exercise this path anywhere else is
 * the mock (`src/lib/stores/dev-settings.svelte.ts`), which fabricates a batch
 * after a short delay instead of taking a cross-chain payment. Nothing here
 * touches a local chain, and nothing here is about the in-app engine — the
 * suites that buy real drives (`drives.test.ts`, `drive-purchase.test.ts`,
 * `drive-onchain.test.ts`) own that, and must keep owning it.
 */
import { type Page, expect, test } from '@playwright/test'

import { addDrive, completeCreateFlow, confirmPurchased } from './helpers'

/**
 * The first page load of a run waits on the dev server transforming the whole
 * module graph, which outlasts the 5s action timeout — hence the explicit wait
 * below rather than clicking straight away. Nothing about the mock is slow: it
 * settles in ~1.5s, and every later step here runs at that speed.
 */
const COLD_START_TIMEOUT_MS = 60_000

// Room for that first load, which the 30s default does not leave.
test.setTimeout(COLD_START_TIMEOUT_MS * 2)

/**
 * Arm the mock before the app's first script runs — `devSettingsStore` reads
 * these keys once, at module import, so setting them afterwards would be too
 * late for the tab under test.
 *
 * `result` is left at its default ('success') unless a test asks otherwise.
 */
function seedMockWidget(page: Page, result?: 'error') {
  return page.addInitScript((outcome) => {
    localStorage.setItem('dev-mock-stamp-enabled', 'true')
    if (outcome) {
      localStorage.setItem('dev-mock-stamp-result', outcome)
    }
  }, result)
}

/** A local (password) account, on whatever endpoints the app ships with. */
async function createLocalAccount(page: Page) {
  await page.goto('/')
  const getStarted = page.getByRole('link', { name: 'Get started' }).first()
  await expect(getStarted).toBeVisible({ timeout: COLD_START_TIMEOUT_MS })
  await getStarted.click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)
}

test('a mocked widget purchase settles and adds the drive', async ({ page }) => {
  await seedMockWidget(page)
  await createLocalAccount(page)

  await addDrive(page)

  // The success screen is modal: acknowledging it is how the drive list becomes
  // reachable again, not decoration.
  await confirmPurchased(page)
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible()
})

test('a mocked widget failure surfaces the error and adds nothing', async ({ page }) => {
  await seedMockWidget(page, 'error')
  await createLocalAccount(page)

  await addDrive(page)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Mock error: Purchase failed')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible()

  // The error screen's own Close, not the header's X — both are named "Close".
  await dialog.getByRole('button', { name: 'Close' }).filter({ hasText: 'Close' }).click()
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toHaveCount(0)
})

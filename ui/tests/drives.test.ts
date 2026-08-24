// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Drive (postage stamp) management on the Storage tab, against the mocked
 * purchase flow (/dev defaults: mock enabled, no widget popup): add, rename,
 * set default, remove, the failed-purchase outcome, and an expired drive's
 * reduced set of actions.
 */
import { expect, test } from '@playwright/test'

import { DRIVE_SETTLE_TIMEOUT_MS, addMockedDrive, completeCreateFlow } from './helpers'

async function createLocalAccount(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)
}

/** The stored drive state, read back through localStorage. */
function storedDrives(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: {
        defaultPostageStampBatchID?: string
        postageStamps?: { batchID: string; name?: string; deletedAt?: number }[]
      }[]
    }
    const record = doc.data?.[0]
    return {
      default: record?.defaultPostageStampBatchID,
      live: (record?.postageStamps ?? [])
        .filter((stamp) => stamp.deletedAt === undefined)
        .map((stamp) => ({ batchID: stamp.batchID, name: stamp.name })),
    }
  })
}

/** Ages every stored drive past its expiry (a TTL snapshot of zero seconds). */
async function expireStoredDrives(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: { postageStamps?: { batchTTL?: number }[] }[]
    }
    for (const stamp of doc.data?.[0]?.postageStamps ?? []) {
      stamp.batchTTL = 0
    }
    localStorage.setItem('swarm-id-accounts', JSON.stringify(doc))
  })
}

test('drive management: add, rename, set default, remove', async ({ page }) => {
  await createLocalAccount(page)

  // The first drive settles and becomes the account default.
  await addMockedDrive(page)
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible({
    timeout: DRIVE_SETTLE_TIMEOUT_MS,
  })
  await expect(page.getByText('Default', { exact: true })).toBeVisible()

  // Rename it (the name input renders in the expanded card).
  await page.getByRole('button', { name: 'Expand drive' }).click()
  const nameInput = page.getByRole('textbox', { name: 'Drive name' })
  await nameInput.fill('Photos')
  await nameInput.press('Enter')
  await expect(page.getByText('Drive renamed')).toBeVisible()
  await page.getByRole('button', { name: 'Collapse drive' }).click()
  await expect(page.getByText('Photos', { exact: true })).toBeVisible()

  // A second drive; make IT the default via its actions menu. An EXPANDED
  // card renders its name as an input (hasText can't see input values), so
  // interactions anchor on the one card showing "Collapse drive".
  const expandedCard = page
    .locator('div.overflow-hidden.rounded-lg')
    .filter({ has: page.getByRole('button', { name: 'Collapse drive' }) })
  await addMockedDrive(page)
  const newCard = page.locator('div.overflow-hidden.rounded-lg', {
    hasText: /Drive [0-9a-f]{4}/,
  })
  await expect(newCard).toBeVisible({ timeout: DRIVE_SETTLE_TIMEOUT_MS })
  await newCard.getByRole('button', { name: 'Expand drive' }).click()
  await expandedCard.getByRole('button', { name: 'Drive actions' }).click()
  await page.getByRole('menuitem', { name: 'Set as default' }).click()

  const afterDefault = await storedDrives(page)
  expect(afterDefault.live).toHaveLength(2)
  const photos = afterDefault.live.find((drive) => drive.name === 'Photos')
  expect(photos).toBeDefined()
  expect(afterDefault.default).not.toBe(photos?.batchID)

  // Remove the renamed (now non-default) drive — collapse the other card
  // first so the expanded-card anchor stays unique.
  await expandedCard.getByRole('button', { name: 'Collapse drive' }).click()
  const photosCard = page.locator('div.overflow-hidden.rounded-lg', { hasText: 'Photos' })
  await photosCard.getByRole('button', { name: 'Expand drive' }).click()
  await expandedCard.getByRole('button', { name: 'Drive actions' }).click()
  await page.getByRole('menuitem', { name: 'Remove' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove drive' }).click()

  await expect(page.getByText('Photos', { exact: true })).not.toBeVisible()
  const afterRemove = await storedDrives(page)
  expect(afterRemove.live).toHaveLength(1)
  expect(afterRemove.default).toBe(afterRemove.live[0].batchID)
})

test('a failed mock purchase surfaces the error and adds nothing', async ({ page }) => {
  // The dev-settings store reads the mock outcome at app init (same-tab
  // localStorage writes fire no storage event) — plant it before any load.
  await page.addInitScript(() => localStorage.setItem('dev-mock-stamp-result', 'error'))
  await createLocalAccount(page)

  await addMockedDrive(page)

  await expect(page.getByText('Mock error: Purchase failed')).toBeVisible({
    timeout: DRIVE_SETTLE_TIMEOUT_MS,
  })
  const drives = await storedDrives(page)
  expect(drives.live).toHaveLength(0)
})

test('an expired drive offers no extend or resize, only removal', async ({ page }) => {
  await createLocalAccount(page)
  await addMockedDrive(page)
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible({
    timeout: DRIVE_SETTLE_TIMEOUT_MS,
  })

  // While the drive lives, the expanded card offers both edits.
  await page.getByRole('button', { name: 'Expand drive' }).click()
  await expect(page.getByRole('button', { name: 'Increase size' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Extend lifespan' })).toBeVisible()

  // Age it past expiry (#545): an expired batch can be neither topped up nor
  // diluted, so both edits go away and removal is all that is left.
  await expireStoredDrives(page)
  await page.reload()
  await page.getByRole('tab', { name: 'Storage' }).click()
  await expect(page.getByText('Drive expired')).toBeVisible()

  await page.getByRole('button', { name: 'Expand drive' }).click()
  await expect(page.getByRole('textbox', { name: 'Drive name' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Increase size' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Extend lifespan' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Drive actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Remove' })).toBeVisible()
})

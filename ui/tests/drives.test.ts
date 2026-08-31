// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Drive (postage stamp) management on the Storage tab: add, rename, set
 * default, remove, the failed-purchase outcome, and an expired drive's reduced
 * set of actions.
 *
 * The bookkeeping cases buy for real against the local chain. What keeps them
 * about drives rather than about paying is that the postage signer is funded
 * out of band first (`fundPostageSigner`), so the operation is never short and
 * the payment screens never open. `payment-rail.test.ts` is where paying is the
 * subject.
 *
 * The two failure cases are the exception, one per method: an unreachable chain
 * for the built-in engine, and the /dev mock's error outcome for fund.bzz.limo,
 * which settles on mainnet and can be reached here no other way.
 */
import { expect, test } from '@playwright/test'

import {
  CHAIN_TEST_TIMEOUT_MS,
  DRIVE_SETTLE_TIMEOUT_MS,
  addDrive,
  chainReachable,
  completeCreateFlow,
  fundPostageSigner,
  seedLocalChain,
  seedNoChain,
} from './helpers'

// Buying through the built-in engine is a real on-chain purchase, and even the
// mocked one needs the chain to reach the payment screen, so this suite needs a
// chain either way.
const chainUp = await chainReachable()
test.skip(!chainUp, 'requires a local chain (pnpm dev:local)')

/**
 * Create an account, against whichever chain the caller seeds.
 *
 * The seeding is a parameter rather than a fixed `seedLocalChain` because
 * `addInitScript` calls stack: a hardcoded working endpoint would overwrite the
 * dead one seeded by the test that checks the "cannot reach the chain" case, so
 * that case would never be exercised.
 */
async function createLocalAccount(
  page: import('@playwright/test').Page,
  seedChain: (page: import('@playwright/test').Page) => Promise<void> = seedLocalChain,
) {
  await seedChain(page)
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
  test.setTimeout(CHAIN_TEST_TIMEOUT_MS)
  await createLocalAccount(page)

  // The first drive settles and becomes the account default.
  await fundPostageSigner(page)
  await addDrive(page)
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
  await fundPostageSigner(page)
  await addDrive(page)
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

// #619: the funding seam used to be the only place the method could be chosen,
// and it is raised only when the owner address is short — so an account holding
// funds from an earlier attempt was committed to the built-in engine, with the
// widget reachable from nowhere. The chooser now precedes the balance read.
test('a funded account is still asked which payment method to use', async ({ page }) => {
  test.setTimeout(CHAIN_TEST_TIMEOUT_MS)
  await createLocalAccount(page)
  // Enough that `quoteFunding` comes back needing zero: the exact state that
  // used to skip the question.
  await fundPostageSigner(page)

  await page.getByRole('tab', { name: 'Storage' }).click()
  await page.getByRole('button', { name: 'Add drive' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').nth(1).selectOption({ index: 1 })
  await dialog.getByRole('spinbutton').fill('30')
  await dialog.getByRole('combobox').nth(2).selectOption('days')
  await page.getByRole('button', { name: 'Proceed' }).click()

  // Both routes on offer, and the purchase not yet started.
  await expect(dialog.getByRole('button', { name: 'Continue to fund.bzz.limo' })).toBeVisible()
  await expect(dialog.locator('option', { hasText: 'built in' })).toHaveCount(1)
  expect((await storedDrives(page)).live).toHaveLength(0)

  // And the engine still settles from the parked funds, with no pay screen.
  await dialog.getByRole('combobox').first().selectOption({ index: 1 })
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await dialog.getByRole('button', { name: 'Done' }).click({ timeout: DRIVE_SETTLE_TIMEOUT_MS })
  expect((await storedDrives(page)).live).toHaveLength(1)
})

test('a purchase that cannot reach the chain surfaces the error and adds nothing', async ({
  page,
}) => {
  test.setTimeout(CHAIN_TEST_TIMEOUT_MS)
  // Point the app at a dead RPC: a real purchase has nothing to buy against,
  // and must say so rather than inventing a drive.
  await createLocalAccount(page, seedNoChain)

  await addDrive(page, { settle: false })

  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible({
    timeout: DRIVE_SETTLE_TIMEOUT_MS,
  })
  // The REASON has to reach the screen, not just a retry button — a bare
  // "Try again" tells the user nothing about which setting is wrong.
  await expect(page.getByText(/Gnosis RPC could not be reached/)).toBeVisible()
  // And no "View details" here: `jsonRpcCall` throws a plain Error whose
  // message is the whole story, so there is nothing behind the button. It used
  // to offer one and reveal a minified stack frame.
  await expect(page.getByRole('button', { name: 'View details' })).toHaveCount(0)
  const drives = await storedDrives(page)
  expect(drives.live).toHaveLength(0)
})

test('a failed mock purchase surfaces the error and adds nothing', async ({ page }) => {
  test.setTimeout(CHAIN_TEST_TIMEOUT_MS)
  // The dev-settings store reads the mock settings at app init (same-tab
  // localStorage writes fire no storage event) — plant them before any load.
  // Popup off, so the simulation settles in-page and needs no window.
  await page.addInitScript(() => {
    localStorage.setItem('dev-mock-stamp-enabled', 'true')
    localStorage.setItem('dev-mock-stamp-popup', 'false')
    localStorage.setItem('dev-mock-stamp-result', 'error')
  })
  await createLocalAccount(page)

  await addDrive(page, { settle: false, method: 'widget' })

  await expect(page.getByText('Mock error: Purchase failed')).toBeVisible({
    timeout: DRIVE_SETTLE_TIMEOUT_MS,
  })
  const drives = await storedDrives(page)
  expect(drives.live).toHaveLength(0)
})

test('an expired drive offers no extend or resize, only removal', async ({ page }) => {
  test.setTimeout(CHAIN_TEST_TIMEOUT_MS)
  await createLocalAccount(page)
  await fundPostageSigner(page)
  await addDrive(page)
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

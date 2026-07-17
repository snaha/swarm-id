// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { type Page, expect, test } from '@playwright/test'

import {
  DRIVE_SETTLE_TIMEOUT_MS,
  PASSWORD,
  addMockedDrive,
  completeCreateFlow,
  openConnectPopup,
} from './helpers'

const DEMO_URL = 'http://localhost:3500'
const APP_NAME = 'Swarm ID Demo'

/**
 * "Go to app" closes the popup from its click handler — under load the window
 * can be gone before the click roundtrip returns, so tolerate that error and
 * assert the closure itself.
 */
async function goToApp(popup: Page) {
  await popup
    .getByRole('button', { name: 'Go to app' })
    .click()
    .catch(() => undefined)
  await expect.poll(() => popup.isClosed()).toBe(true)
}

/** Asserts the shared done view's drive pitch (the no-drive branch). */
async function expectDrivePitch(page: Page) {
  await expect(page.getByText('Your Swarm ID is ready!')).toBeVisible()
  await expect(page.getByText('Want the full experience?')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Set up a drive' })).toBeVisible()
}

test('create flow ends on the done page with the drive pitch', async ({ page }) => {
  await page.goto('/')
  // A first visit lands on the product page; "Get started" opts into the
  // account chooser (/?signin).
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)

  await expect(page).toHaveURL(/\/account\/new\/done$/)
  await expect(page.getByText('Account created successfully!')).toBeVisible()
  await expectDrivePitch(page)
  await expect(page.getByRole('button', { name: 'Stay local for now' })).toBeVisible()

  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)
})

test('first connect with a single drive confirms without picker or pitch', async ({ page }) => {
  // Account created standalone with exactly one drive, never connected.
  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)
  await addMockedDrive(page)
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible({
    timeout: DRIVE_SETTLE_TIMEOUT_MS,
  })

  // First connect + one drive → the drive question answers itself: plain
  // confirmation, no picker, no pitch.
  await page.goto(DEMO_URL)
  const popup = await openConnectPopup(page)
  await expect(popup.getByText('Previously used with this app')).not.toBeVisible()
  await popup.getByRole('button', { name: /0x[0-9a-fA-F]{4}/ }).click()
  await popup.getByRole('textbox', { name: 'Account password' }).fill(PASSWORD)
  await popup.getByRole('button', { name: 'Confirm' }).click()

  await expect(popup.getByText(`Your Swarm ID is now connected to ${APP_NAME}!`)).toBeVisible()
  await expect(popup.getByText('Select drive')).not.toBeVisible()
  await expect(popup.getByText('Want the full experience?')).not.toBeVisible()
  await goToApp(popup)
})

test('connect flow shows the done screen variants and closes the popup', async ({ page }) => {
  await page.goto(DEMO_URL)

  // Fresh profile: create the account inside the connect popup. No drives yet
  // → the confirmation shows the (secondary) drive pitch card.
  let popup = await openConnectPopup(page)
  await completeCreateFlow(popup)

  await expect(popup).toHaveURL(/\/connect\/done$/)
  await expect(popup.getByText(`Your Swarm ID is now connected to ${APP_NAME}!`)).toBeVisible()
  await expect(popup.getByText('Want the full experience?')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Set up a drive' })).toBeVisible()

  await goToApp(popup)

  // The demo picked up the session — the sidebar shows the account.
  const accountButton = page.getByRole('button', { name: /0x|[0-9a-f]{6}\.\.\./ }).first()
  await expect(accountButton).toBeVisible({ timeout: 10000 })

  // Give the account a drive via the mocked Add-drive flow (dev default:
  // mock enabled, no widget popup).
  await page.goto('/')
  await addMockedDrive(page)
  // Drive cards are labelled "Drive <4 hex chars>" (batch-ID-derived name).
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible({
    timeout: DRIVE_SETTLE_TIMEOUT_MS,
  })

  // Disconnect and reconnect: the lapsed connection lists the account under
  // "Previously used with this app" — with NO "Signed out" badge, since the
  // account is still signed in (#445). Reconnecting is NOT a first connect
  // and the drive question was settled, so the done screen is the plain
  // confirmation: no drive picker, no pitch.
  await page.goto(DEMO_URL)
  await accountButton.click()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()

  popup = await openConnectPopup(page)
  await expect(popup.getByText('Previously used with this app')).toBeVisible()
  await expect(popup.getByText('Signed out')).not.toBeVisible()
  await popup.getByRole('button', { name: /0x[0-9a-fA-F]{4}/ }).click()
  await popup.getByRole('textbox', { name: 'Account password' }).fill(PASSWORD)
  await popup.getByRole('button', { name: 'Confirm' }).click()

  await expect(popup.getByText(`Your Swarm ID is now connected to ${APP_NAME}!`)).toBeVisible()
  await expect(popup.getByText('Select drive')).not.toBeVisible()
  await expect(popup.getByText('Want the full experience?')).not.toBeVisible()
  await goToApp(popup)

  // REMOVING the app from the account (Apps tab → Remove) revokes the
  // association entirely — unlike a disconnect, the account must no longer
  // list under "Previously used with this app" (the removal leaves a revoked
  // tombstone in the record for sync, which must not resurrect it).
  await page.goto('/')
  await page.getByRole('tab', { name: 'Apps' }).click()
  await page.getByRole('button', { name: 'App actions' }).click()
  await page.getByRole('menuitem', { name: 'Remove' }).click()

  // A second drive, so the NEXT (first-again) connect must ask which drive
  // the app should use.
  await addMockedDrive(page)
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toHaveCount(2, {
    timeout: DRIVE_SETTLE_TIMEOUT_MS,
  })

  await page.goto(DEMO_URL)
  popup = await openConnectPopup(page)
  await expect(popup.getByRole('button', { name: /0x[0-9a-fA-F]{4}/ })).toBeVisible()
  await expect(popup.getByText('Previously used with this app')).not.toBeVisible()
  await popup.getByRole('button', { name: /0x[0-9a-fA-F]{4}/ }).click()
  await popup.getByRole('textbox', { name: 'Account password' }).fill(PASSWORD)
  await popup.getByRole('button', { name: 'Confirm' }).click()

  // First connect (the removal reset the association) + two drives → the
  // drive picker, with the account default preselected.
  await expect(popup.getByText('Select drive')).toBeVisible()
  const drivePicker = popup.getByRole('combobox')
  await expect(drivePicker).toHaveValue(/[0-9a-f]{64}/)
  expect(await drivePicker.locator('option', { hasText: '(default)' }).count()).toBe(1)
  // Choose the non-default drive; the choice must land on the app entry.
  await drivePicker.selectOption({ index: 1 })
  await goToApp(popup)

  await page.goto('/')
  const appDrive = await page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: { connectedApps?: { appUrl: string; postageStampBatchID?: string }[] }[]
    }
    return doc.data
      ?.flatMap((account) => account.connectedApps ?? [])
      .find((app) => app.appUrl === 'http://localhost:3500')?.postageStampBatchID
  })
  expect(appDrive).toMatch(/^[0-9a-f]{64}$/)

  // Storage warnings (#437): mark one drive full → the home page shows the
  // attention alert (any tab), and its link jumps to Storage.
  await page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: { postageStamps?: { utilization: number }[] }[]
    }
    const stamps = doc.data?.[0]?.postageStamps
    if (stamps?.[0]) stamps[0].utilization = 1
    localStorage.setItem('swarm-id-accounts', JSON.stringify(doc))
  })
  await page.reload()
  await expect(page.getByText('1 drive needs attention.')).toBeVisible()
  await page.getByRole('button', { name: 'Check your storage' }).click()
  await expect(page.getByText('Your drives')).toBeVisible()

  // The connect chooser shows the destructive "Check storage" action on the
  // account row instead of any badge; pressing it opens the Storage tab.
  // (Disconnect first — with a live session the demo has no Connect button.)
  await page.goto(DEMO_URL)
  await accountButton.click()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  popup = await openConnectPopup(page)
  const checkStorage = popup.getByRole('button', { name: 'Check storage' })
  await expect(checkStorage).toBeVisible()
  // Press near the top edge: a pressed-state transform that shifts the button
  // out from under the pointer would swallow this click (regression guard).
  // Storage opens in a NEW window; the connect popup keeps its request.
  const storagePagePromise = popup.waitForEvent('popup')
  await checkStorage.click({ position: { x: 20, y: 4 } })
  const storagePage = await storagePagePromise
  await expect(storagePage.getByText('Your drives')).toBeVisible()
  await expect(storagePage.getByText('1 drive needs attention.')).toBeVisible()
  await expect(popup.getByText(`Connect to ${APP_NAME}`)).toBeVisible()
})

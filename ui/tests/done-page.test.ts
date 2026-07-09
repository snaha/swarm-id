// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { type Page, expect, test } from '@playwright/test'

const DEMO_URL = 'http://localhost:3500'
const PASSWORD = 'testpassword123'
const APP_NAME = 'Swarm ID Demo'
// The mocked drive purchase settles after a simulated widget delay.
const DRIVE_SETTLE_TIMEOUT_MS = 15000

/**
 * Drives the account-creation wizard from /account/new to completion using the
 * Password access method (needs no WebAuthn/wallet test infra). Where the flow
 * lands afterwards depends on the entry point: the done page when standalone,
 * /connect/done inside a connect popup.
 */
async function completeCreateFlow(page: Page) {
  await page.getByRole('link', { name: 'Create a new account' }).click()
  await expect(page).toHaveURL(/\/account\/new$/)
  // Name is prefilled with a generated one.
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page).toHaveURL(/\/account\/new\/phrase$/)
  await page.getByRole('button', { name: 'Reveal' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page).toHaveURL(/\/account\/new\/access$/)
  await page.getByRole('tab', { name: 'Password' }).click()
  await page.locator('#new-password').fill(PASSWORD)
  await page.locator('#verify-password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Confirm' }).click()
}

/** Asserts the shared done view's drive pitch (the no-drive branch). */
async function expectDrivePitch(page: Page) {
  await expect(page.getByText('Your Swarm ID is ready!')).toBeVisible()
  await expect(page.getByText('Want the full experience?')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Set up a drive' })).toBeVisible()
}

/** Opens the demo's connect popup and returns the popup page. */
async function openConnectPopup(page: Page) {
  await page.getByRole('button', { name: 'Connect Swarm ID' }).click()
  // The lib renders the iframe button once the client is initialized — before
  // that, the popover's Connect click is a silent no-op (clientStore.connect
  // bails while `client` is undefined).
  await expect(page.locator('#swarm-id-button iframe')).toBeVisible({ timeout: 10000 })
  let popup: Page | undefined
  await expect(async () => {
    const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => undefined)
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    popup = await popupPromise
    if (!popup) {
      // Clicking Connect closes the popover — reopen it for the retry.
      await page.getByRole('button', { name: 'Connect Swarm ID' }).click()
      throw new Error('connect popup did not open')
    }
  }).toPass({ timeout: 30000 })
  await popup!.waitForLoadState()
  return popup!
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

test('connect flow shows the same done page and closes the popup', async ({ page }) => {
  await page.goto(DEMO_URL)

  // Fresh profile: create the account inside the connect popup.
  let popup = await openConnectPopup(page)
  await completeCreateFlow(popup)

  await expect(popup).toHaveURL(/\/connect\/done$/)
  await expect(popup.getByText(`Connected to ${APP_NAME}!`)).toBeVisible()
  await expectDrivePitch(popup)
  await expect(popup.getByRole('button', { name: 'Continue to app' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Stay local for now' })).not.toBeVisible()

  await popup.getByRole('button', { name: 'Continue to app' }).click()
  await expect.poll(() => popup.isClosed()).toBe(true)

  // The demo picked up the session — the sidebar shows the account.
  const accountButton = page.getByRole('button', { name: /0x|[0-9a-f]{6}\.\.\./ }).first()
  await expect(accountButton).toBeVisible({ timeout: 10000 })

  // Give the account a drive via the mocked Add-drive flow (dev default:
  // mock enabled, no widget popup).
  await page.goto('/')
  await page.getByRole('tab', { name: 'Storage' }).click()
  await page.getByRole('button', { name: 'Add drive' }).click()
  await page.getByRole('dialog').getByRole('combobox').nth(1).selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Proceed' }).click()
  // Drive cards are labelled "Drive <4 hex chars>" (batch-ID-derived name).
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible({
    timeout: DRIVE_SETTLE_TIMEOUT_MS,
  })

  // Disconnect and reconnect: the account now has a drive, so the done page
  // skips the pitch and shows the "All set!" branch.
  await page.goto(DEMO_URL)
  await accountButton.click()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()

  popup = await openConnectPopup(page)
  await popup.getByRole('button', { name: /Signed out/ }).click()
  await popup.getByRole('textbox', { name: 'Account password' }).fill(PASSWORD)
  await popup.getByRole('button', { name: 'Confirm' }).click()

  await expect(popup).toHaveURL(/\/connect\/done$/)
  await expect(popup.getByText('All set!')).toBeVisible()
  await expect(popup.getByText(`Your account is connected to ${APP_NAME}.`)).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Set up a drive' })).not.toBeVisible()

  await popup.getByRole('button', { name: 'Continue to app' }).click()
  await expect.poll(() => popup.isClosed()).toBe(true)
})

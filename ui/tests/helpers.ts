// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Shared journey helpers for the e2e suites: the password create flow, the
 * demo's connect popup, and the mocked drive purchase (`/dev` defaults: mock
 * enabled, no widget popup).
 */
import { type Page, expect } from '@playwright/test'

export const PASSWORD = 'testpassword123'
/** The mocked drive purchase settles after a simulated widget delay. */
export const DRIVE_SETTLE_TIMEOUT_MS = 15000

/**
 * Drives the account-creation wizard from /account/new to completion using the
 * Password access method (needs no WebAuthn/wallet test infra). Where the flow
 * lands afterwards depends on the entry point: the done page when standalone,
 * /connect/done inside a connect popup.
 */
export async function completeCreateFlow(page: Page) {
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

/** Opens the demo's connect popup and returns the popup page. */
export async function openConnectPopup(page: Page) {
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

/**
 * Point the app at an RPC nothing answers, for suites that mock a purchase but
 * have no chain to settle against.
 *
 * A purchase only simulates off Gnosis mainnet, and the default endpoint IS
 * mainnet — so without this the flow would open the real payment widget and
 * wait forever. Unreachable counts as "not mainnet", and with no chain behind
 * it the batch is fabricated: instant, and nothing is spent anywhere.
 *
 * Must run before the first page load; the settings are read at app init.
 */
export function seedNoChain(page: Page) {
  return page.addInitScript(() => {
    localStorage.setItem(
      'swarm-id-network-settings',
      JSON.stringify({
        beeNodeUrl: 'http://localhost:1633/',
        // Connection refused immediately, rather than a slow DNS failure.
        gnosisRpcUrl: 'http://127.0.0.1:1',
      }),
    )
  })
}

/**
 * Starts a mocked Add-drive purchase from the home page (Storage tab). The
 * purchase settles asynchronously — callers assert the outcome (a "Drive
 * xxxx" card, or the error phase) with `DRIVE_SETTLE_TIMEOUT_MS`.
 */
export async function addMockedDrive(page: Page) {
  await page.getByRole('tab', { name: 'Storage' }).click()
  await page.getByRole('button', { name: 'Add drive' }).click()
  await page.getByRole('dialog').getByRole('combobox').nth(1).selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Proceed' }).click()
}

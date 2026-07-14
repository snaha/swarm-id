// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { type Page, expect, test } from '@playwright/test'

// At least MIN_PASSWORD_LENGTH (8) characters.
const PASSWORD = 'test-password-123'

async function gotoSignin(page: Page) {
  await page.goto('/?signin')
  // The first load on a cold dev server compiles the route on demand; give
  // the shell extra time to appear before the default action timeout applies.
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 15000 })
}

// The network settings dialog is reachable from a fresh profile through the
// settings menu — no account required.
async function openNetworkSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Network settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Network settings' })).toBeVisible()
}

// Creates a password-protected account and lands in the app shell, where the
// Backup section holds a persistent opener for the unlock dialog.
async function createPasswordAccount(page: Page) {
  await page.goto('/')
  const getStarted = page.getByRole('link', { name: 'Get started' }).first()
  await expect(getStarted).toBeVisible({ timeout: 15000 })
  await getStarted.click()
  await page.getByRole('link', { name: 'Create a new account' }).click()

  await expect(page).toHaveURL(/\/account\/new$/)
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page).toHaveURL(/\/account\/new\/phrase$/)
  await page.getByRole('button', { name: 'Reveal' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page).toHaveURL(/\/account\/new\/access$/)
  await page.getByRole('tab', { name: 'Password' }).click()
  await page.locator('#new-password').fill(PASSWORD)
  await page.locator('#verify-password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()

  await expect(page).toHaveURL(/\/account\/new\/done$/)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)
}

test('dialog moves focus inside on open and wraps Tab at both ends', async ({ page }) => {
  await gotoSignin(page)
  await openNetworkSettings(page)

  const dialog = page.getByRole('dialog', { name: 'Network settings' })
  const close = dialog.getByRole('button', { name: 'Close' })
  const reset = dialog.getByRole('button', { name: 'Reset' })

  // Initial focus lands on the dialog's first focusable control.
  await expect(close).toBeFocused()

  // Shift+Tab from the first control wraps to the last...
  await page.keyboard.press('Shift+Tab')
  await expect(reset).toBeFocused()

  // ...and Tab from the last wraps back to the first — never the page behind.
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
})

test('Escape closes the dialog', async ({ page }) => {
  await gotoSignin(page)
  await openNetworkSettings(page)

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Network settings' })).toBeHidden()
})

test('initial focus skips invisible controls', async ({ page }) => {
  await gotoSignin(page)

  // Hide the dialog's first focusable (the X) before it opens: initial focus
  // must skip it — focusing an invisible element silently fails — and land on
  // the first visible control instead.
  await page.addStyleTag({
    content: '[role="dialog"] button[aria-label="Close"] { visibility: hidden }',
  })
  await openNetworkSettings(page)

  const dialog = page.getByRole('dialog', { name: 'Network settings' })
  await expect(dialog.locator('#bee-node-url')).toBeFocused()
})

test('a hidden data-autofocus mark is skipped', async ({ page }) => {
  await createPasswordAccount(page)

  // Hide the marked password input before the dialog opens (`display: none`,
  // the other way an element can be invisible): the mark must lose to the
  // first visible focusable control.
  await page.addStyleTag({ content: '[role="dialog"] [data-autofocus] { display: none }' })
  await page.getByRole('tab', { name: 'Account' }).click()
  await page.getByRole('button', { name: /^Backup/ }).click()
  await page.getByRole('button', { name: 'Export .swarmid file' }).click()

  const dialog = page.getByRole('dialog', { name: 'Export backup' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
})

test.describe('touch-primary devices', () => {
  // `hasTouch` makes `(pointer: coarse)` match in Chromium — the signal the
  // dialog uses to keep the software keyboard down on open.
  test.use({ hasTouch: true })

  test('text inputs are not autofocused, so no software keyboard pops up', async ({ page }) => {
    await createPasswordAccount(page)

    await page.getByRole('tab', { name: 'Account' }).click()
    await page.getByRole('button', { name: /^Backup/ }).click()
    await page.getByRole('button', { name: 'Export .swarmid file' }).click()

    // Focus still moves into the dialog, but onto the panel itself — focusing
    // the marked password field would summon the keyboard mid-animation.
    const dialog = page.getByRole('dialog', { name: 'Export backup' })
    await expect(dialog).toBeFocused()
    await expect(dialog.getByPlaceholder('Account password')).not.toBeFocused()
  })

  test('non-text controls still receive initial focus', async ({ page }) => {
    await gotoSignin(page)
    await openNetworkSettings(page)

    const dialog = page.getByRole('dialog', { name: 'Network settings' })
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
  })
})

test('unlock dialog autofocuses the password input and returns focus to its opener', async ({
  page,
}) => {
  await createPasswordAccount(page)

  await page.getByRole('tab', { name: 'Account' }).click()
  await page.getByRole('button', { name: /^Backup/ }).click()
  const opener = page.getByRole('button', { name: 'Export .swarmid file' })
  await opener.click()

  // `data-autofocus` beats the first-focusable default: the password input is
  // ready to type into.
  const dialog = page.getByRole('dialog', { name: 'Export backup' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByPlaceholder('Account password')).toBeFocused()

  // Closing hands focus back to the opener.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { type Page, expect, test } from '@playwright/test'

// Walks a fresh profile to the access step, whose tablist has three tabs
// (Passkey / ETH wallet / Password) — enough to exercise wrap-around and
// Home/End. The account is left un-finalized; this file is about the tablist.
async function gotoAccessStep(page: Page) {
  await page.goto('/')
  // The first load on a cold dev server compiles the route on demand; give
  // the shell extra time to appear before the default action timeout applies.
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
}

test('arrow keys move tab focus and selection, wrapping at both ends', async ({ page }) => {
  await gotoAccessStep(page)

  const passkey = page.getByRole('tab', { name: 'Passkey' })
  const wallet = page.getByRole('tab', { name: 'ETH wallet' })
  const password = page.getByRole('tab', { name: 'Password' })

  await passkey.click()
  await expect(passkey).toBeFocused()

  // Automatic activation: arrows move focus and selection together.
  await page.keyboard.press('ArrowRight')
  await expect(wallet).toBeFocused()
  await expect(wallet).toHaveAttribute('aria-selected', 'true')
  await expect(passkey).toHaveAttribute('aria-selected', 'false')

  await page.keyboard.press('ArrowRight')
  await expect(password).toBeFocused()
  await expect(password).toHaveAttribute('aria-selected', 'true')
  // Selection is live — the password panel replaced the passkey copy.
  await expect(page.locator('#new-password')).toBeVisible()

  // ArrowRight from the last tab wraps to the first...
  await page.keyboard.press('ArrowRight')
  await expect(passkey).toBeFocused()
  await expect(passkey).toHaveAttribute('aria-selected', 'true')

  // ...and ArrowLeft from the first wraps back to the last.
  await page.keyboard.press('ArrowLeft')
  await expect(password).toBeFocused()
  await expect(password).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('Home')
  await expect(passkey).toBeFocused()
  await expect(passkey).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('End')
  await expect(password).toBeFocused()
  await expect(password).toHaveAttribute('aria-selected', 'true')
})

test('the tablist is a single Tab stop (roving tabindex)', async ({ page }) => {
  await gotoAccessStep(page)

  const passkey = page.getByRole('tab', { name: 'Passkey' })
  const wallet = page.getByRole('tab', { name: 'ETH wallet' })
  const password = page.getByRole('tab', { name: 'Password' })

  // Only the selected tab participates in the page Tab order.
  await expect(passkey).toHaveAttribute('tabindex', '0')
  await expect(wallet).toHaveAttribute('tabindex', '-1')
  await expect(password).toHaveAttribute('tabindex', '-1')

  // Tab from the selected tab leaves the tablist for the panel content
  // instead of visiting the remaining tabs.
  await passkey.click()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Confirm with passkey' })).toBeFocused()
})

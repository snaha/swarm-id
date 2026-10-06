// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test'

import { completeCreateFlow } from './helpers'

// A fresh browser context has empty localStorage, so a first visit lands on the
// product page. "Get started" (→ /?signin) opts into the account chooser.
test('fresh profile lands on the product page and can reach the account chooser', async ({
  page,
}) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'The Identity Layer on Swarm' })).toBeVisible()

  await page.getByRole('link', { name: 'Get started' }).first().click()

  await expect(page).toHaveURL(/\?signin$/)
  await expect(page.getByRole('link', { name: 'Create a new account' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'I already have an account' })).toBeVisible()
})

// #840: the home tabs are linkable — `#<tab>[/<target>…]` opens the tab, and
// the target within it; picking a tab writes the hash back.
test('the URL hash selects a tab and opens what it names', async ({ page }) => {
  await page.goto('/?signin')
  await expect(page.getByRole('link', { name: 'Create a new account' })).toBeVisible({
    timeout: 15000,
  })
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)

  // A hash change on the open page, then the same link on a fresh load.
  for (const load of [() => page.goto('/#account/keys/data-sharing'), () => page.reload()]) {
    await load()
    await expect(page.getByRole('tab', { name: 'Account' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByText('Sharing public key')).toBeVisible()
  }

  await page.getByRole('tab', { name: 'Storage' }).click()
  await expect(page).toHaveURL(/\/#storage$/)
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Storage' })).toHaveAttribute('aria-selected', 'true')
})

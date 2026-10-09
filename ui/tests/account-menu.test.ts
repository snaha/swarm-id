// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The account menu's one way to another account is "Add another account"
 * (#834), landing on the Get Started page that offers both creating one and
 * signing in to one — frame 159-8517.
 */
import { expect, test } from '@playwright/test'

import { completeCreateFlow } from './helpers'

test('the account menu links to the Get Started page', async ({ page }) => {
  await page.goto('/?signin')
  // The first load of the run is the dev server compiling; give it the same
  // room the other suites give their first element.
  await expect(page.getByRole('link', { name: 'Create a new account' })).toBeVisible({
    timeout: 15000,
  })
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)

  await page.getByRole('button', { name: 'Switch account' }).click()
  const menu = page.getByRole('menu')
  await menu.getByRole('link', { name: 'Add another account' }).click()

  await expect(page).toHaveURL(/\/account\/add$/)
  await expect(page.getByRole('link', { name: 'Create a new account' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'I already have an account' })).toBeVisible()
})

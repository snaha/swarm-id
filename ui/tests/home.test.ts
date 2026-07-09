// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test'

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

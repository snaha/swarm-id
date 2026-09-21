// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The account menu offers creating an account directly (#727): it used to hide
 * behind "Sign in to another account", which rewrote the menu into the
 * create/import choice. Both are pages now — frame 159-8517.
 */
import { expect, test } from '@playwright/test'

import { completeCreateFlow } from './helpers'

test('the account menu links to creating an account and to the Get Started page', async ({
  page,
}) => {
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
  await expect(menu.getByRole('link', { name: 'Create a new account' })).toHaveAttribute(
    'href',
    /\/account\/new$/,
  )
  await menu.getByRole('link', { name: 'Sign in to another account' }).click()

  await expect(page).toHaveURL(/\/account\/add$/)
  await expect(page.getByRole('link', { name: 'Create a new account' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'I already have an account' })).toBeVisible()
})

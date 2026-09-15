// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test'

// The one error page (`+error.svelte`). A shipped build also puts it at /dev
// in place of the developer tools, which the dev server this suite runs
// against cannot show — the bundle guard in CI covers that side.
test('an unknown route renders the error page with a way home', async ({ page }) => {
  await page.goto('/no-such-page')

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await expect(page.getByText('404')).toBeVisible()

  await page.getByRole('link', { name: 'Go home' }).click()

  await expect(page).toHaveURL(/\/$/)
})

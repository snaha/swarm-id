// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from '@playwright/test'

test('home page loads successfully', async ({ page }) => {
  await page.goto('/')
  // When no accounts exist, redirects to account creation page
  await expect(page.getByRole('heading', { name: 'The Identity System for Swarm' })).toBeVisible()
})

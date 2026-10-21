// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test'

// The permissions page grants with no unlock (#711), so it refuses to render
// inside another site's frame: a framed "Save permissions" is a clickjacking
// target. Chain-free: the refusal comes before any account is looked up.
const PERMISSIONS_URL = 'http://localhost:5500/permissions#origin=https%3A%2F%2Fapp.example'

test('the permissions page refuses to render inside a frame', async ({ page }) => {
  await page.setContent(`<iframe src="${PERMISSIONS_URL}" width="600" height="600"></iframe>`)

  const framed = page.frameLocator('iframe')
  await expect(framed.getByText('This page cannot be shown inside another site.')).toBeVisible()
  await expect(framed.getByRole('button', { name: 'Save permissions' })).toHaveCount(0)
})

test('the permissions page renders at top level', async ({ page }) => {
  await page.goto(PERMISSIONS_URL)

  await expect(page.getByText('Permissions for https://app.example')).toBeVisible()
  await expect(page.getByText('This account is not on this device.')).toBeVisible()
})

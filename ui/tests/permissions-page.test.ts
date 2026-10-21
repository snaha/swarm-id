// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test'

import { PASSWORD, completeCreateFlow, goToApp, openConnectPopup, seedNoChain } from './helpers'

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

// #885: the sharing switches. Account-wide on the Apps tab, pinned per app on
// the Permissions page, asked for by the app with `requestPermissions()`.
// Chain-free: no drive is involved, and a local account connects without one.
const DEMO_URL = 'http://localhost:3500'
const APP_NAME = 'Swarm ID Demo'

test('the sharing switches gate the key, are asked for, and are pinned per app', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await seedNoChain(page)
  await page.goto('/?signin')
  await expect(page.getByRole('link', { name: 'Create a new account' })).toBeVisible({
    timeout: 15000,
  })
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)

  // Account-wide: data sharing off hides write access, as on the app's page.
  await page.getByRole('tab', { name: 'Apps' }).click()
  const dataSharing = page.getByRole('switch', { name: 'Data sharing' })
  await expect(dataSharing).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('switch', { name: 'Write access' })).toBeVisible()
  await dataSharing.click()
  await expect(dataSharing).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByRole('switch', { name: 'Write access' })).toHaveCount(0)

  // The app connects into that default: no sharing key, and a request offered.
  await page.goto(DEMO_URL)
  const popup = await openConnectPopup(page)
  await popup.getByRole('button', { name: /0x[0-9a-fA-F]{4}/ }).click()
  await popup.getByRole('textbox', { name: 'Account password' }).fill(PASSWORD)
  await popup.getByRole('button', { name: 'Confirm' }).click()
  await goToApp(popup)
  const requestButton = page.getByRole('button', { name: 'Request data sharing' })
  await expect(requestButton).toBeVisible({ timeout: 15000 })
  await page.goto(`${DEMO_URL}/account`)
  await expect(page.getByText('Sharing key withheld')).toBeVisible()
  await expect(page.getByText('Sharing Key', { exact: true })).toHaveCount(0)

  // The app asks: the page shows that one switch, off; turning it on pins it.
  await page.goto(DEMO_URL)
  const popupPromise = page.waitForEvent('popup')
  await requestButton.click()
  const permissions = await popupPromise
  await expect(permissions.getByText(`Permissions for ${APP_NAME}`)).toBeVisible()
  await expect(permissions.getByRole('combobox')).toHaveCount(0)
  const asked = permissions.getByRole('switch', { name: 'Data sharing' })
  await expect(asked).toHaveAttribute('aria-checked', 'false')
  await expect(permissions.getByRole('switch', { name: 'Write access' })).toHaveCount(0)
  await asked.click()
  await permissions
    .getByRole('button', { name: 'Save permissions' })
    .click()
    .catch(() => undefined)
  await expect.poll(() => permissions.isClosed()).toBe(true)

  // The live session sees it: the key is back, and nothing left to ask.
  await expect(requestButton).toHaveCount(0, { timeout: 15000 })
  await page.goto(`${DEMO_URL}/account`)
  await expect(page.getByText('Sharing Key', { exact: true })).toBeVisible()

  // Pinned apart from the account default: badged on the Apps tab, and the
  // app's page offers the default back. Taking it leaves the app following.
  await page.goto('/')
  await page.getByRole('tab', { name: 'Apps' }).click()
  await expect(page.getByText('Custom permissions')).toBeVisible()
  await page.getByRole('button', { name: 'App actions' }).click()
  await page.getByRole('menuitem', { name: 'Permissions' }).click()
  await expect(page.getByText(`Permissions for ${APP_NAME}`)).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Data sharing' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(page.getByText('Account default: off')).toBeVisible()
  await page.getByRole('button', { name: 'Use account default' }).click()
  await expect(page.getByRole('switch', { name: 'Data sharing' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await expect(page.getByText('Account default: off')).toHaveCount(0)
  await page.getByRole('button', { name: 'Save permissions' }).click()
  await expect(page.getByText('Permissions saved')).toBeVisible()
  await expect(page.getByText('Custom permissions')).toHaveCount(0)
})

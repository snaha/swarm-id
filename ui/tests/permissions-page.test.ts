// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test'

import { PASSWORD, completeCreateFlow, goToApp, openConnectPopup, seedNoChain } from './helpers'

// The permissions page grants with no unlock (#711), so it refuses to render
// inside another site's frame: a framed "Save permissions" is a clickjacking
// target. Chain-free: the refusal comes before any account is looked up.
const PERMISSIONS_URL =
  'http://localhost:5500/permissions#origin=https%3A%2F%2Fapp.example&permissions=%7B%7D'

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
  const accountButton = page.getByRole('button', { name: /0x|[0-9a-f]{6}\.\.\./ }).first()
  await expect(accountButton).toBeVisible({ timeout: 10000 })
  await page.goto(`${DEMO_URL}/account`)
  await expect(page.getByText('Sharing key withheld')).toBeVisible()
  await expect(page.getByText('Sharing Key', { exact: true })).toHaveCount(0)

  // The app asks, from the demo's Permissions page: the popup shows that one
  // switch, off; turning it on pins it.
  await page.goto(`${DEMO_URL}/permissions`)
  await expect(page.getByText('Data sharing: off')).toBeVisible()
  await page.getByRole('checkbox', { name: 'Data sharing', exact: true }).last().click()
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Request permissions' }).click()
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

  // The live session sees it: the key is back.
  await expect(page.getByText('Data sharing: on')).toBeVisible({ timeout: 15000 })
  await page.goto(`${DEMO_URL}/account`)
  await expect(page.getByText('Sharing Key', { exact: true })).toBeVisible()

  // Pinned apart from the account default: badged on the Apps tab, and the
  // app's own page (Frame 154) offers the default back, applying at once.
  // Taking it leaves the app following the account again.
  await page.goto('/')
  await page.getByRole('tab', { name: 'Apps' }).click()
  await expect(page.getByText('Custom permissions')).toBeVisible()
  await page.getByRole('button', { name: APP_NAME }).click()
  await expect(page).toHaveURL(/#apps\/http%3A%2F%2Flocalhost%3A3500$/)
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
  await page.getByRole('button', { name: 'Back to apps' }).click()
  await expect(page.getByText('Custom permissions')).toHaveCount(0)
  await expect(page).toHaveURL(/#apps$/)

  // The app's own session length counts as custom too, until reset.
  await page.getByRole('button', { name: APP_NAME }).click()
  const duration = page.getByRole('combobox', { name: 'Keep app connected for' })
  await expect(duration).toHaveValue('30')
  await duration.selectOption('7')
  await expect(page.getByText('Account default: 30 days')).toBeVisible()
  await page.getByRole('button', { name: 'Back to apps' }).click()
  await expect(page.getByText('Custom permissions')).toBeVisible()
  await page.getByRole('button', { name: APP_NAME }).click()
  await page.getByRole('button', { name: 'Use account default' }).click()
  await expect(duration).toHaveValue('30')
  await page.getByRole('button', { name: 'Back to apps' }).click()
  await expect(page.getByText('Custom permissions')).toHaveCount(0)

  // Disconnect from the app's page: the row says so, and the page offers
  // Revoke access alone.
  await page.getByRole('button', { name: APP_NAME }).click()
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await expect(page.getByRole('button', { name: 'Disconnect' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to apps' }).click()
  await expect(page.getByText('Disconnected')).toBeVisible()
})

// A switch asked for at connect that is not already on is put on the connect
// screen beside the drives; turned on there, it is pinned with the connection.
test('a switch requested at connect is asked on the connect screen', async ({ page }) => {
  test.setTimeout(120_000)
  await seedNoChain(page)
  await page.addInitScript(() => {
    localStorage.setItem(
      'swarm-id-demo-sharing-request',
      JSON.stringify({ dataSharing: true, writeAccess: true }),
    )
  })
  await page.goto('/?signin')
  await expect(page.getByRole('link', { name: 'Create a new account' })).toBeVisible({
    timeout: 15000,
  })
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.getByRole('tab', { name: 'Apps' }).click()
  await page.getByRole('switch', { name: 'Data sharing' }).click()

  await page.goto(DEMO_URL)
  const popup = await openConnectPopup(page)
  await popup.getByRole('button', { name: /0x[0-9a-fA-F]{4}/ }).click()
  await popup.getByRole('textbox', { name: 'Account password' }).fill(PASSWORD)
  await popup.getByRole('button', { name: 'Confirm' }).click()
  await expect(popup.getByText(`Connect your Swarm ID to ${APP_NAME}`)).toBeVisible()
  // Data sharing is off for the account, so both are asked; write access is
  // there from the start but only enabled once data sharing is on.
  const asked = popup.getByRole('switch', { name: 'Data sharing' })
  const write = popup.getByRole('switch', { name: 'Write access' })
  await expect(asked).toHaveAttribute('aria-checked', 'false')
  await expect(write).toBeDisabled()
  await asked.click()
  await expect(write).toBeEnabled()
  await write.click()
  await expect(write).toHaveAttribute('aria-checked', 'true')
  // Turning data sharing off takes write access with it; on again, it is asked afresh.
  await asked.click()
  await expect(write).toBeDisabled()
  await expect(write).toHaveAttribute('aria-checked', 'false')
  await asked.click()
  await write.click()
  await goToApp(popup)

  // Granted with the connection: the app has its key, nothing left to ask.
  const accountButton = page.getByRole('button', { name: /0x|[0-9a-f]{6}\.\.\./ }).first()
  await expect(accountButton).toBeVisible({ timeout: 10000 })
  await page.goto(`${DEMO_URL}/permissions`)
  await expect(page.getByText('Data sharing: on')).toBeVisible()
  await expect(page.getByText('Write access: on')).toBeVisible()
  await page.goto(`${DEMO_URL}/account`)
  await expect(page.getByText('Sharing Key', { exact: true })).toBeVisible()
})

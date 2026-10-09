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

  // #848: the drive management card is linkable too, shows the postage batch
  // signer, and a collapsed card hides a revealed private key again.
  await page.goto('/#account/keys/drive-management')
  await expect(page.getByText('Postage batch signer address')).toBeVisible()
  await page.getByRole('button', { name: 'Reveal postage batch signer private key' }).click()
  await expect(page.getByText(/^0x[0-9a-f]{64}$/)).toBeVisible()
  await page.getByRole('button', { name: 'Hide drive management keys' }).click()
  await page.getByRole('button', { name: 'Show drive management keys' }).click()
  await expect(page.getByText(/^0x[0-9a-f]{64}$/)).toBeHidden()
  await expect(
    page.getByRole('button', { name: 'Reveal postage batch signer private key' }),
  ).toBeVisible()

  // A section opened from a link still collapses, and stays collapsed.
  const keys = page.getByRole('button', { name: /Keys & addresses/ })
  await keys.click()
  await expect(keys).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText('Sharing public key')).toBeHidden()

  // Unknown targets: an unknown tab lands on Apps, an unknown section (or an
  // inherited object key) on Account with nothing expanded.
  await page.goto('/#bogus')
  await expect(page.getByRole('tab', { name: 'Apps' })).toHaveAttribute('aria-selected', 'true')
  for (const hash of ['#account/bogus', '#account/constructor']) {
    await page.goto(`/${hash}`)
    await expect(page.getByRole('tab', { name: 'Account' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(keys).toBeVisible()
    await expect(page.locator('button[id^="account-"][aria-expanded="true"]')).toHaveCount(0)
  }

  await page.getByRole('tab', { name: 'Storage' }).click()
  await expect(page).toHaveURL(/\/#storage$/)
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Storage' })).toHaveAttribute('aria-selected', 'true')
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test'

import { completeCreateFlow, seedNoChain } from './helpers'

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
  const signerKey = await page.getByText(/^0x[0-9a-f]{64}$/).textContent()
  await page.getByRole('button', { name: 'Hide drive management keys' }).click()
  await page.getByRole('button', { name: 'Show drive management keys' }).click()
  await expect(page.getByText(/^0x[0-9a-f]{64}$/)).toBeHidden()
  const reveal = page.getByRole('button', { name: 'Reveal postage batch signer private key' })
  await expect(reveal).toBeVisible()

  // A section opened from a link still collapses, and stays collapsed — and
  // forgets a reveal made inside it.
  await reveal.click()
  await expect(page.getByText(/^0x[0-9a-f]{64}$/)).toBeVisible()
  const keys = page.getByRole('button', { name: /Keys & addresses/ })
  await keys.click()
  await expect(keys).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText('Sharing public key')).toBeHidden()
  await keys.click()
  await expect(page.getByText(/^0x[0-9a-f]{64}$/)).toBeHidden()
  await expect(reveal).toBeVisible()

  // The shown signer is the one drives are bought with: /dev derives it on the
  // purchase path and shows the same key.
  await page.goto('/dev')
  await page.getByRole('tab', { name: 'Chain' }).click()
  const devKey = page.getByText(/^[0-9a-f]{64}$/)
  await expect(devKey).toBeVisible()
  expect(`0x${await devKey.textContent()}`).toBe(signerKey)
  await page.goto('/')

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

// Frame 157 (#892). Chain-free: the two expired drives are written straight
// into the stored account, the default one among them.
test('expired drives are alerted on every tab until dismissed', async ({ page }) => {
  await seedNoChain(page)
  await page.goto('/?signin')
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: { postageStamps?: object[]; defaultPostageStampBatchID?: string }[]
    }
    const record = doc.data?.[0]
    if (!record) throw new Error('no stored account')
    const stamp = (hexChar: string, name: string) => ({
      batchID: hexChar.repeat(64),
      signerKey: 'b'.repeat(64),
      name,
      utilization: 0,
      usable: true,
      depth: 24,
      amount: '100000000',
      bucketDepth: 16,
      blockNumber: 1,
      immutableFlag: false,
      exists: true,
      batchTTL: 0,
      createdAt: Date.now(),
    })
    record.postageStamps = [stamp('1', 'Drive 1'), stamp('5', 'Drive 5')]
    record.defaultPostageStampBatchID = '1'.repeat(64)
    localStorage.setItem('swarm-id-accounts', JSON.stringify(doc))
  })
  await page.reload()

  const defaultAlert = page.getByText('Your default drive has expired.')
  const otherAlert = page.getByText('Drive 5 has expired.')
  await expect(defaultAlert).toBeVisible()
  await expect(otherAlert).toBeVisible()
  await page.getByRole('tab', { name: 'Account' }).click()
  await expect(defaultAlert).toBeVisible()

  // The second alert's close button: the default drive's comes first.
  await page.getByRole('button', { name: 'Dismiss' }).nth(1).click()
  await expect(otherAlert).toHaveCount(0)
  await page.reload()
  await expect(defaultAlert).toBeVisible()
  await expect(otherAlert).toHaveCount(0)

  // The drive list shows the badge instead of a size.
  await page.getByRole('tab', { name: 'Storage' }).click()
  await expect(page.getByText('Drive expired')).toHaveCount(2)

  // The connect popup's account chooser flags the account too (Frame 148).
  await page.goto('/connect#origin=https%3A%2F%2Fapp.example')
  await expect(page.getByRole('button', { name: 'Drive expired' })).toBeVisible()
})

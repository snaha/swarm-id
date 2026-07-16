// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The sign-out → sign-back-in journey: sign-out strips the account to an
 * encrypted remnant (vault + state snapshot + storage-warning fields, no
 * plaintext derivationKey), and unlocking with the existing password restores
 * everything from the snapshot — no recovery phrase, no network. The
 * storage-warning remnant outranks the "Signed out" badge in the chooser.
 */
import { type Page, expect, test } from '@playwright/test'

import { DRIVE_SETTLE_TIMEOUT_MS, PASSWORD, addMockedDrive, completeCreateFlow } from './helpers'

async function createAccountWithDrive(page: Page) {
  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)
  // A drive makes the account non-local — sign-out is only offered then.
  await addMockedDrive(page)
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible({
    timeout: DRIVE_SETTLE_TIMEOUT_MS,
  })
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Switch account' }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click()
}

test('sign out keeps only the encrypted remnant and signs back in from it', async ({ page }) => {
  await createAccountWithDrive(page)
  await signOut(page)

  // Back on the chooser, the row carries the badge ("Signed out" also shows
  // briefly as a toast — first() tolerates the overlap).
  await expect(page.getByText('Signed out').first()).toBeVisible()

  // The stored record is the minimal remnant: vault + snapshot + the
  // storage-warning fields — and no plaintext secrets.
  const remnant = await page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: Record<string, unknown>[]
    }
    const record = doc.data?.[0] ?? {}
    return { keys: Object.keys(record).sort(), raw: JSON.stringify(record) }
  })
  // `soonestDriveExpiry` is optional — it only exists when a drive's TTL is
  // known, and the mocked purchase records none.
  expect(remnant.keys.filter((key) => key !== 'soonestDriveExpiry')).toEqual([
    'access',
    'createdAt',
    'encryptedSeed',
    'encryptedState',
    'id',
    'name',
    'signedOutAt',
    'storageWarning',
  ])
  expect(remnant.raw).not.toContain('derivationKey')

  // Sign back in with the password alone; the snapshot restores the drive
  // without touching the network.
  await page.getByRole('button', { name: /0x/ }).click()
  await expect(page.getByText(/Sign in as/)).toBeVisible()
  await page.getByRole('textbox', { name: 'Account password' }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Confirm' }).click()

  await page.getByRole('tab', { name: 'Storage' }).click()
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible()
})

test('the storage warning survives sign-out and outranks the badge', async ({ page }) => {
  await createAccountWithDrive(page)

  // Fill the drive so the sign-out captures a storage warning, then reload so
  // the store re-reads the tampered record (same-tab writes fire no event).
  await page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: { postageStamps?: { utilization: number }[] }[]
    }
    const stamps = doc.data?.[0]?.postageStamps
    if (stamps?.[0]) stamps[0].utilization = 1
    localStorage.setItem('swarm-id-accounts', JSON.stringify(doc))
  })
  await page.reload()
  await signOut(page)

  // The warning wins the badge slot; "Signed out" is gone once its toast
  // auto-dismisses.
  const checkStorage = page.getByRole('button', { name: 'Check storage' })
  await expect(checkStorage).toBeVisible()
  await expect(page.getByText('Signed out')).not.toBeVisible({ timeout: 10000 })

  // Checking storage on a signed-out account signs it back in first.
  await checkStorage.click({ position: { x: 20, y: 4 } })
  await expect(page.getByText(/check your storage/i)).toBeVisible()
  await page.getByRole('textbox', { name: 'Account password' }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Confirm' }).click()

  await expect(page.getByText('Your drives')).toBeVisible()
  await expect(page.getByText('1 drive needs attention.')).toBeVisible()
})

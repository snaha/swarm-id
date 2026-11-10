// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { type Page, expect, test } from '@playwright/test'

import { gotoAccessStep, installVirtualAuthenticator } from './helpers'

// STORAGE_KEY_ACCOUNTS from @snaha/swarm-id, inlined — the lib's browser
// bundle cannot be imported into Node-side Playwright specs.
const STORAGE_KEY_ACCOUNTS = 'swarm-id-accounts'

// Test-only hooks the encrypt gate installs on window (see gateSeedEncryption).
interface EncryptGate {
  __encryptHeld: boolean
  __encryptDone: boolean
  __releaseEncrypt: () => void
}

// Holds every crypto.subtle.encrypt call until the test releases it. In the
// create flow the only encrypt is finalize()'s encryptSeed, so this parks
// finalization right after the passkey ceremony — the exact window where a
// Cancel click must win the race (#423). __encryptHeld flags that finalize
// reached the gate; __encryptDone that the released call finished.
async function gateSeedEncryption(page: Page) {
  await page.addInitScript(() => {
    const gate = window as unknown as EncryptGate
    const released = new Promise<void>((resolve) => {
      gate.__releaseEncrypt = resolve
    })
    const original = SubtleCrypto.prototype.encrypt
    SubtleCrypto.prototype.encrypt = async function (...args: Parameters<SubtleCrypto['encrypt']>) {
      gate.__encryptHeld = true
      await released
      const result = await original.apply(this, args)
      gate.__encryptDone = true
      return result
    }
  })
}

test('passkey happy path creates a usable local account', async ({ page }) => {
  const authenticator = await installVirtualAuthenticator(page)

  // The access step defaults to the Passkey tab; the virtual authenticator
  // answers the ceremony automatically.
  await gotoAccessStep(page)
  await page.getByRole('button', { name: 'Confirm with passkey' }).click()

  await expect(page).toHaveURL(/\/account\/new\/done$/)
  await expect(page.getByText('Account created successfully!')).toBeVisible()

  // Staying local drops into the app shell for the freshly created account.
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('tab', { name: 'Account' })).toBeVisible()
  // A working passkey is never signalled away.
  expect(await authenticator.storedCredentials()).toBe(1)
})

test('cancel during finalization does not create the account (#423)', async ({ page }) => {
  await installVirtualAuthenticator(page)
  await gateSeedEncryption(page)
  await gotoAccessStep(page)

  await page.getByRole('button', { name: 'Confirm with passkey' }).click()

  // The ceremony resolved and finalize() is parked on the gated encryptSeed —
  // cancel exactly in that window.
  await page.waitForFunction(() => (window as unknown as EncryptGate).__encryptHeld)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('button', { name: 'Confirm with passkey' })).toBeVisible()

  // Let the held encryption finish: the superseded finalize must bail without
  // persisting an account or navigating away.
  await page.evaluate(() => (window as unknown as EncryptGate).__releaseEncrypt())
  await page.waitForFunction(() => (window as unknown as EncryptGate).__encryptDone)

  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY_ACCOUNTS)).toBeNull()
  await expect(page).toHaveURL(/\/account\/new\/access$/)

  // The step is still functional: a fresh confirm (gate now open) completes.
  await page.getByRole('button', { name: 'Confirm with passkey' }).click()
  await expect(page).toHaveURL(/\/account\/new\/done$/)
  await expect(page.getByText('Account created successfully!')).toBeVisible()
})

test('a passkey without PRF is rejected, explained, and signalled for removal (#870)', async ({
  page,
}) => {
  // A passkey manager without PRF (e.g. KeePassXC) stores the passkey before
  // the page can tell PRF is missing — the orphan must be signalled away and
  // the user told what happened and what works instead.
  const authenticator = await installVirtualAuthenticator(page, { hasPrf: false })
  await gotoAccessStep(page)
  await page.getByRole('button', { name: 'Confirm with passkey' }).click()

  await expect(
    page.getByText(
      /does not support the PRF extension.*cannot unlock this account.*Password or ETH wallet/,
    ),
  ).toBeVisible()
  await expect(page).toHaveURL(/\/account\/new\/access$/)
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY_ACCOUNTS)).toBeNull()
  // signalUnknownCredential reached the authenticator: the orphan is gone.
  expect(await authenticator.storedCredentials()).toBe(0)

  // The other methods are right there: switching tabs drops the stale error
  // and password still completes the flow.
  await page.getByRole('tab', { name: 'Password' }).click()
  await expect(page.getByText(/cannot unlock this account/)).toBeHidden()
  await page.locator('#new-password').fill('correct horse battery staple')
  await page.locator('#verify-password').fill('correct horse battery staple')
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page).toHaveURL(/\/account\/new\/done$/)
})

test('a passkey whose follow-up assertion returns no PRF output is dropped too (#870)', async ({
  page,
}) => {
  // The other PRF failure: registration claims PRF but evaluates nothing, and
  // the follow-up get() returns nothing either. No virtual authenticator does
  // this on its own, so the extension results are faked on top of a PRF-capable one.
  const authenticator = await installVirtualAuthenticator(page)
  await page.addInitScript(() => {
    const original = PublicKeyCredential.prototype.getClientExtensionResults
    PublicKeyCredential.prototype.getClientExtensionResults = function () {
      return this.response instanceof AuthenticatorAttestationResponse
        ? { prf: { enabled: true } }
        : { ...original.call(this), prf: {} }
    }
  })
  await gotoAccessStep(page)
  await page.getByRole('button', { name: 'Confirm with passkey' }).click()

  await expect(
    page.getByText(/did not return PRF results.*cannot unlock this account/),
  ).toBeVisible()
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY_ACCOUNTS)).toBeNull()
  expect(await authenticator.storedCredentials()).toBe(0)
})

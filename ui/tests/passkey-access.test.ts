// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { type Page, expect, test } from '@playwright/test'

// STORAGE_KEY_ACCOUNTS from @snaha/swarm-id, inlined — the lib's browser
// bundle cannot be imported into Node-side Playwright specs.
const STORAGE_KEY_ACCOUNTS = 'swarm-id-accounts'

// Test-only hooks the encrypt gate installs on window (see gateSeedEncryption).
interface EncryptGate {
  __encryptHeld: boolean
  __encryptDone: boolean
  __releaseEncrypt: () => void
}

// Installs a Chrome virtual WebAuthn authenticator so the passkey ceremony
// resolves without real hardware. It must expose the PRF extension (hmac-secret)
// and be a resident-key, user-verifying platform authenticator — passkey.ts
// derives the seed-encryption key from PRF output and requires all three.
async function installVirtualAuthenticator(page: Page) {
  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable')
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      // Auto-satisfy user presence/verification so create() needs no interaction.
      automaticPresenceSimulation: true,
      isUserVerified: true,
    },
  })
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

// Walks the create wizard from the home page to the access step.
async function gotoAccessStep(page: Page) {
  await page.goto('/')
  // The first hit on a cold dev server pays vite's on-demand transform of the
  // whole route graph — give the initial render extra headroom.
  await page.getByRole('link', { name: 'Get started' }).first().click({ timeout: 15000 })
  await page.getByRole('link', { name: 'Create a new account' }).click()

  await expect(page).toHaveURL(/\/account\/new$/)
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page).toHaveURL(/\/account\/new\/phrase$/)
  await page.getByRole('button', { name: 'Reveal' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page).toHaveURL(/\/account\/new\/access$/)
}

test('passkey happy path creates a usable local account', async ({ page }) => {
  await installVirtualAuthenticator(page)

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

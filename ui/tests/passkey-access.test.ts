// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { type Page, expect, test } from '@playwright/test'

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

test('passkey happy path creates a usable local account', async ({ page }) => {
  await installVirtualAuthenticator(page)

  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await page.getByRole('link', { name: 'Create a new account' }).click()

  await expect(page).toHaveURL(/\/account\/new$/)
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page).toHaveURL(/\/account\/new\/phrase$/)
  await page.getByRole('button', { name: 'Reveal' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  // The access step defaults to the Passkey tab; the virtual authenticator
  // answers the ceremony automatically.
  await expect(page).toHaveURL(/\/account\/new\/access$/)
  await page.getByRole('button', { name: 'Confirm with passkey' }).click()

  await expect(page).toHaveURL(/\/account\/new\/done$/)
  await expect(page.getByText('Account created successfully!')).toBeVisible()

  // Staying local drops into the app shell for the freshly created account.
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('tab', { name: 'Account' })).toBeVisible()
})

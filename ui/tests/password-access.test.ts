// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { type Page, expect, test } from '@playwright/test'

// At least MIN_PASSWORD_LENGTH (8) characters.
const PASSWORD = 'test-password-123'
const SHORT_PASSWORD = 'short'

// Walks a fresh profile through the create wizard to the access step and
// selects the Password tab, leaving the account un-finalized. Name and phrase
// use their generated defaults — this file is about the password step itself.
async function gotoPasswordAccessStep(page: Page) {
  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await page.getByRole('link', { name: 'Create a new account' }).click()

  await expect(page).toHaveURL(/\/account\/new$/)
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page).toHaveURL(/\/account\/new\/phrase$/)
  await page.getByRole('button', { name: 'Reveal' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page).toHaveURL(/\/account\/new\/access$/)
  await page.getByRole('tab', { name: 'Password' }).click()
}

test('password step keeps Confirm disabled until the input is valid', async ({ page }) => {
  await gotoPasswordAccessStep(page)

  const newPassword = page.locator('#new-password')
  const verifyPassword = page.locator('#verify-password')
  const confirm = page.getByRole('button', { name: 'Confirm', exact: true })

  await expect(confirm).toBeDisabled()

  // Too short: the field flags invalid and Confirm stays disabled.
  await newPassword.fill(SHORT_PASSWORD)
  await expect(newPassword).toHaveAttribute('aria-invalid', 'true')
  await expect(confirm).toBeDisabled()

  // Long enough but the verify field disagrees: mismatch shown, still disabled.
  await newPassword.fill(PASSWORD)
  await verifyPassword.fill(`${PASSWORD}-typo`)
  await expect(page.getByText('Passwords do not match')).toBeVisible()
  await expect(confirm).toBeDisabled()

  // Matching and long enough: the guardrails clear and Confirm enables.
  await verifyPassword.fill(PASSWORD)
  await expect(page.getByText('Passwords do not match')).toBeHidden()
  await expect(confirm).toBeEnabled()
})

test('password step can reveal the typed password', async ({ page }) => {
  await gotoPasswordAccessStep(page)

  const newPassword = page.locator('#new-password')
  await newPassword.fill(PASSWORD)
  await expect(newPassword).toHaveAttribute('type', 'password')

  // Two identical toggles (new + verify); the first belongs to #new-password.
  await page.getByRole('button', { name: 'Show password' }).first().click()
  await expect(newPassword).toHaveAttribute('type', 'text')
  await expect(newPassword).toHaveValue(PASSWORD)

  await page.getByRole('button', { name: 'Hide password' }).first().click()
  await expect(newPassword).toHaveAttribute('type', 'password')
})

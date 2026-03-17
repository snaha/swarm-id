import { test, expect } from '@playwright/test'

test('home page loads successfully', async ({ page }) => {
  await page.goto('/')
  // When no accounts exist, redirects to account creation page
  await expect(page.getByRole('heading', { name: 'The Identity System for Swarm' })).toBeVisible()
})

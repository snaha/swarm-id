import { test, expect } from '@playwright/test'

test('home page loads successfully', async ({ page }) => {
	await page.goto('/')
	// When no accounts exist, redirects to account creation page
	await expect(page.locator('h4')).toContainText('Swarm ID')
})

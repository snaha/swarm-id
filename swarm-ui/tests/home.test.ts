import { test, expect } from '@playwright/test'

test('home page loads successfully', async ({ page }) => {
	await page.goto('/')
	await expect(page.locator('h1')).toContainText('Swarm Identity')
})

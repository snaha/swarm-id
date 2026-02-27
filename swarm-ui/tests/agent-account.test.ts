import { test, expect } from '@playwright/test'

// Standard BIP39 test mnemonic (well-known test phrase)
// Derives to address: 0x9858EfFD232B4033E47d90003D41EC34EcaEda94
const TEST_SEED_PHRASE =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const TEST_APP_ORIGIN = 'https://test-app.example.com'
const TEST_APP_NAME = 'TestApp'

test.describe('Agent Account', () => {
	test.beforeEach(async ({ page }) => {
		// Clear localStorage before each test for clean state
		await page.goto('/')
		await page.evaluate(() => localStorage.clear())
	})

	test('create agent account and identity', async ({ page }) => {
		// Navigate to agent signup (SvelteKit route groups don't appear in URLs)
		await page.goto('/agent/new')

		// Wait for page to load
		await expect(page.locator('text=Sign up as Agent')).toBeVisible()

		// Fill account name
		await page.fill('[name="account-name"]', 'Test Agent')

		// Enter seed phrase
		await page.fill('textarea.seed-phrase-input', TEST_SEED_PHRASE)

		// Verify "Valid seed phrase" shown
		await expect(page.getByText('Valid seed phrase')).toBeVisible()

		// Click create
		await page.click('button:has-text("Create Agent Account")')

		// Should navigate to identity creation
		await page.waitForURL(/identity\/new/)

		// Identity creation page should be visible
		await expect(page.locator('text=Create identity')).toBeVisible()

		// Identity name is auto-generated, just click Confirm
		await page.click('button:has-text("Confirm")')

		// Should navigate to home (local account skips stamp setup)
		await page.waitForURL('/')
		// Home page shows "Welcome to Swarm ID" in h4
		await expect(page.getByRole('heading', { name: 'Welcome to Swarm ID' })).toBeVisible()
	})

	test('connect with agent account shows seed phrase modal', async ({ page }) => {
		// First: Create the agent account and identity
		await page.goto('/agent/new')
		await expect(page.locator('text=Sign up as Agent')).toBeVisible()

		await page.fill('[name="account-name"]', 'Test Agent')
		await page.fill('textarea.seed-phrase-input', TEST_SEED_PHRASE)
		await expect(page.getByText('Valid seed phrase')).toBeVisible()

		await page.click('button:has-text("Create Agent Account")')
		await page.waitForURL(/identity\/new/)

		await page.click('button:has-text("Confirm")')
		await page.waitForURL('/')

		// Navigate to connect page with app params via hash
		await page.goto(`/connect#origin=${TEST_APP_ORIGIN}&appName=${TEST_APP_NAME}`)

		// Wait for the page to parse hash params and show app header
		await expect(page.getByText(TEST_APP_NAME)).toBeVisible({ timeout: 10000 })

		// Wait for the identity list to load
		const identityButton = page.locator('.identity-button').first()
		await expect(identityButton).toBeVisible()

		await identityButton.click()

		// Seed phrase modal should appear (agent accounts require seed phrase)
		await expect(page.getByRole('heading', { name: 'Enter Seed Phrase' })).toBeVisible()

		// Enter seed phrase in the modal textarea
		const modalTextarea = page.locator('textarea.seed-phrase-input').last()
		await modalTextarea.fill(TEST_SEED_PHRASE)
		await expect(page.getByText('Valid seed phrase')).toBeVisible()

		// Click Unlock button
		await page.getByRole('button', { name: 'Unlock' }).click()

		// Should show success
		await expect(page.getByText('All set!')).toBeVisible({ timeout: 15000 })
	})
})

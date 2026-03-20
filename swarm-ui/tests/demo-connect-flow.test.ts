import { test, expect, type Page } from '@playwright/test'

// Standard BIP39 test mnemonic (well-known test phrase)
const TEST_SEED_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const DEMO_URL = 'http://localhost:3000'
const SWARM_UI_URL = 'http://localhost:5174'

// Helper to click the Connect button in the popover and wait for popup
async function clickConnectAndWaitForPopup(page: Page) {
  // Wait for the client to be ready - the iframe section becomes visible when initialized
  // The iframe button div should be visible (even if the button inside is in an iframe)
  await expect(page.locator('#swarm-id-button')).toBeVisible({ timeout: 10000 })
  // Wait a moment for the iframe to fully initialize
  await page.waitForTimeout(1000)

  // Start waiting for popup before clicking
  const popupPromise = page.waitForEvent('popup', { timeout: 15000 })

  // Click the Connect button inside the popover content
  // The popover content is in a div that appears when popover is open
  // Use a more specific selector to target the button with exact text "Connect"
  await page.locator('div.bg-popover button:text-is("Connect")').click()

  const popup = await popupPromise
  await popup.waitForLoadState()
  return popup
}

test.describe('Demo App Connect Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage on both origins for clean state
    await page.goto(SWARM_UI_URL)
    await page.evaluate(() => localStorage.clear())
    await page.goto(DEMO_URL)
    await page.evaluate(() => {
      localStorage.clear()
      // Set the storage verification flag to enable the Connect button on HTTP
      // This simulates the state after clicking the iframe button to verify storage
      localStorage.setItem('swarm-demo-storage-verified', 'true')
    })
  })

  test('connect from demo with local agent account', async ({ page }) => {
    // Go to demo app
    await page.goto(DEMO_URL)

    // Wait for the Swarm ID client to initialize (button should be enabled)
    await expect(page.locator('button:has-text("Connect Swarm ID")')).toBeVisible()

    // Click "Connect Swarm ID" button to open popover
    await page.click('button:has-text("Connect Swarm ID")')

    // Wait for popover content to be visible
    await expect(page.locator('text=Library API')).toBeVisible()

    // Check "Agent sign-up" checkbox
    await page.click('#popover-agent-signup')

    // Click Connect and wait for popup
    const popup = await clickConnectAndWaitForPopup(page)

    // In popup: Click "Sign up as agent" link
    await popup.click('a:has-text("Sign up as agent")')
    await popup.waitForURL(/agent\/new/)

    // Fill agent form (local type by default)
    await popup.fill('[name="account-name"]', 'Demo Test Agent')
    await popup.fill('textarea.seed-phrase-input', TEST_SEED_PHRASE)
    await expect(popup.getByText('Valid seed phrase')).toBeVisible()

    // Click "Create Agent Account"
    await popup.click('button:has-text("Create Agent Account")')
    await popup.waitForURL(/identity\/new/)

    // Identity creation page - click Confirm
    await expect(popup.locator('text=Create identity')).toBeVisible()
    await popup.click('button:has-text("Confirm")')

    // Should navigate back to /connect (local account skips stamps)
    await popup.waitForURL(/connect/)

    // Authentication happens automatically using the temporary master key from identity creation
    // Should show success screen directly
    await expect(popup.getByText('All set!')).toBeVisible({ timeout: 15000 })

    // Click "Continue to app" button - this triggers window.close() and storage events
    await popup.click('button:has-text("Continue to app")')

    // The popup calls window.close() but in test environment this might not fire the close event
    // Instead, verify the authentication worked by checking the main page
    // The storage event should have triggered the auth state update in the demo app
    await expect(page.locator('.min-w-0.flex-1 .text-sm.font-medium')).toBeVisible({
      timeout: 15000,
    })
    // The address is displayed in truncated format (first 6 chars + ... + last 4 chars)
    // For the test seed phrase, the address is 0x9858EfFD...EcaEda94
    await expect(page.locator('.min-w-0.flex-1 .text-xs.font-mono')).toContainText('...')
  })

  test('connect from demo with synced agent account and stamp', async ({ page }) => {
    // Go to demo app
    await page.goto(DEMO_URL)

    // Wait for the Swarm ID client to initialize
    await expect(page.locator('button:has-text("Connect Swarm ID")')).toBeVisible()

    // Click "Connect Swarm ID" button to open popover
    await page.click('button:has-text("Connect Swarm ID")')

    // Wait for popover content to be visible
    await expect(page.locator('text=Library API')).toBeVisible()

    // Check "Agent sign-up" checkbox
    await page.click('#popover-agent-signup')

    // Click Connect and wait for popup
    const popup = await clickConnectAndWaitForPopup(page)

    // In popup: Click "Sign up as agent" link
    await popup.click('a:has-text("Sign up as agent")')
    await popup.waitForURL(/agent\/new/)

    // Fill agent form with SYNCED type
    await popup.fill('[name="account-name"]', 'Demo Synced Agent')

    // Select "Synced" in Account type dropdown
    const accountTypeSelect = popup.locator('.account-type .select')
    await accountTypeSelect.click()
    await popup.click('text=Synced')

    // Enter seed phrase
    await popup.fill('textarea.seed-phrase-input', TEST_SEED_PHRASE)
    await expect(popup.getByText('Valid seed phrase')).toBeVisible()

    // Click "Create Agent Account"
    await popup.click('button:has-text("Create Agent Account")')
    await popup.waitForURL(/identity\/new/)

    // Identity creation page
    await expect(popup.locator('text=Create identity')).toBeVisible()

    // Verify "Postage stamp" selector is visible (only for synced accounts)
    await expect(popup.getByText('Postage stamp')).toBeVisible()

    // Click Confirm
    await popup.click('button:has-text("Confirm")')

    // Should navigate to stamps/account/new
    await popup.waitForURL(/stamps\/account\/new/)

    // Click "Purchase new stamp" button
    await popup.click('button:has-text("Purchase new stamp")')

    // In connect flow, autoNavigateOnSuccess is true, so after stamp purchase completes,
    // it navigates directly to /connect without showing the stamp success screen
    await popup.waitForURL(/connect/, { timeout: 30000 })

    // Authentication happens automatically using the temporary master key from identity creation
    // Should show success screen directly
    await expect(popup.getByText('All set!')).toBeVisible({ timeout: 15000 })

    // Click "Continue to app" button - this triggers window.close() and storage events
    await popup.click('button:has-text("Continue to app")')

    // The popup calls window.close() but in test environment this might not fire the close event
    // Instead, verify the authentication worked by checking the main page
    await expect(page.locator('.min-w-0.flex-1 .text-sm.font-medium')).toBeVisible({
      timeout: 15000,
    })
    // The address is displayed in truncated format (first 6 chars + ... + last 4 chars)
    // For the test seed phrase, the address is 0x9858EfFD...EcaEda94
    await expect(page.locator('.min-w-0.flex-1 .text-xs.font-mono')).toContainText('...')
  })

  test('connect from demo with synced agent account skip stamp', async ({ page }) => {
    // Go to demo app
    await page.goto(DEMO_URL)

    // Wait for the Swarm ID client to initialize
    await expect(page.locator('button:has-text("Connect Swarm ID")')).toBeVisible()

    // Click "Connect Swarm ID" button to open popover
    await page.click('button:has-text("Connect Swarm ID")')

    // Wait for popover content to be visible
    await expect(page.locator('text=Library API')).toBeVisible()

    // Check "Agent sign-up" checkbox
    await page.click('#popover-agent-signup')

    // Click Connect and wait for popup
    const popup = await clickConnectAndWaitForPopup(page)

    // In popup: Click "Sign up as agent" link
    await popup.click('a:has-text("Sign up as agent")')
    await popup.waitForURL(/agent\/new/)

    // Fill agent form with SYNCED type
    await popup.fill('[name="account-name"]', 'Demo Skip Stamp Agent')

    // Select "Synced" in Account type dropdown
    const accountTypeSelect = popup.locator('.account-type .select')
    await accountTypeSelect.click()
    await popup.click('text=Synced')

    // Enter seed phrase
    await popup.fill('textarea.seed-phrase-input', TEST_SEED_PHRASE)
    await expect(popup.getByText('Valid seed phrase')).toBeVisible()

    // Click "Create Agent Account"
    await popup.click('button:has-text("Create Agent Account")')
    await popup.waitForURL(/identity\/new/)

    // Identity creation page - click Confirm
    await expect(popup.locator('text=Create identity')).toBeVisible()
    await popup.click('button:has-text("Confirm")')

    // Should navigate to stamps/account/new
    await popup.waitForURL(/stamps\/account\/new/)

    // Click "Skip this step" link
    await popup.click('button.link:has-text("Skip this step")')

    // Should navigate back to /connect
    await popup.waitForURL(/connect/)

    // Authentication happens automatically using the temporary master key from identity creation
    // Should show success screen directly
    await expect(popup.getByText('All set!')).toBeVisible({ timeout: 15000 })

    // Click "Continue to app" button - this triggers window.close() and storage events
    await popup.click('button:has-text("Continue to app")')

    // The popup calls window.close() but in test environment this might not fire the close event
    // Instead, verify the authentication worked by checking the main page
    await expect(page.locator('.min-w-0.flex-1 .text-sm.font-medium')).toBeVisible({
      timeout: 15000,
    })
    // The address is displayed in truncated format (first 6 chars + ... + last 4 chars)
    // For the test seed phrase, the address is 0x9858EfFD...EcaEda94
    await expect(page.locator('.min-w-0.flex-1 .text-xs.font-mono')).toContainText('...')
  })

  test('connect from demo with synced agent account and separate identity stamp', async ({
    page,
  }) => {
    // Go to demo app
    await page.goto(DEMO_URL)

    // Wait for the Swarm ID client to initialize
    await expect(page.locator('button:has-text("Connect Swarm ID")')).toBeVisible()

    // Click "Connect Swarm ID" button to open popover
    await page.click('button:has-text("Connect Swarm ID")')

    // Wait for popover content to be visible
    await expect(page.locator('text=Library API')).toBeVisible()

    // Check "Agent sign-up" checkbox
    await page.click('#popover-agent-signup')

    // Click Connect and wait for popup
    const popup = await clickConnectAndWaitForPopup(page)

    // In popup: Click "Sign up as agent" link
    await popup.click('a:has-text("Sign up as agent")')
    await popup.waitForURL(/agent\/new/)

    // Fill agent form with SYNCED type
    await popup.fill('[name="account-name"]', 'Demo Separate Stamp Agent')

    // Select "Synced" in Account type dropdown
    const accountTypeSelect = popup.locator('.account-type .select')
    await accountTypeSelect.click()
    await popup.click('text=Synced')

    // Enter seed phrase
    await popup.fill('textarea.seed-phrase-input', TEST_SEED_PHRASE)
    await expect(popup.getByText('Valid seed phrase')).toBeVisible()

    // Click "Create Agent Account"
    await popup.click('button:has-text("Create Agent Account")')
    await popup.waitForURL(/identity\/new/)

    // Identity creation page
    await expect(popup.locator('text=Create identity')).toBeVisible()

    // Verify "Postage stamp" selector is visible (only for synced accounts)
    await expect(popup.getByText('Postage stamp')).toBeVisible()

    // Click the stamp selector and choose "Use separate stamp (advanced)"
    const stampSelect = popup
      .locator('label:has-text("Postage stamp")')
      .locator('..')
      .locator('.select')
    await stampSelect.click()
    await popup.click('text=Use separate stamp (advanced)')

    // Click Confirm
    await popup.click('button:has-text("Confirm")')

    // Should navigate to stamps/account/new FIRST (need both stamps)
    await popup.waitForURL(/stamps\/account\/new/)

    // Click "Purchase new stamp" button for account stamp
    await popup.click('button:has-text("Purchase new stamp")')

    // After account stamp purchase, auto-navigates to identity stamp page
    await popup.waitForURL(/stamps\/identity\/new/, { timeout: 30000 })

    // Click "Purchase new stamp" button for identity stamp
    await popup.click('button:has-text("Purchase new stamp")')

    // Auto-navigates to /connect after identity stamp purchase completes
    await popup.waitForURL(/connect/, { timeout: 30000 })

    // Authentication happens automatically using the temporary master key from identity creation
    // Should show success screen directly
    await expect(popup.getByText('All set!')).toBeVisible({ timeout: 15000 })

    // Click "Continue to app" button - this triggers window.close() and storage events
    await popup.click('button:has-text("Continue to app")')

    // The popup calls window.close() but in test environment this might not fire the close event
    // Instead, verify the authentication worked by checking the main page
    await expect(page.locator('.min-w-0.flex-1 .text-sm.font-medium')).toBeVisible({
      timeout: 15000,
    })
    // The address is displayed in truncated format (first 6 chars + ... + last 4 chars)
    // For the test seed phrase, the address is 0x9858EfFD...EcaEda94
    await expect(page.locator('.min-w-0.flex-1 .text-xs.font-mono')).toContainText('...')
  })
})

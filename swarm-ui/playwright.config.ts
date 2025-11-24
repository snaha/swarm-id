import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
	testDir: './tests',
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: 'html',
	timeout: 30000,
	expect: {
		timeout: 5000,
	},
	use: {
		baseURL: 'http://localhost:5173',
		trace: 'on-first-retry',
		actionTimeout: 5000,
		navigationTimeout: 10000,
	},

	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				launchOptions: {
					args: [
						'--disable-dev-shm-usage',
						'--no-sandbox',
						'--disable-setuid-sandbox',
						'--disable-gpu',
						'--disable-web-security',
						'--disable-features=VizDisplayCompositor',
					],
				},
			},
		},
	],

	webServer: {
		command: 'pnpm dev',
		port: 5173,
		reuseExistingServer: !process.env.CI,
		timeout: 30000,
		stdout: 'pipe',
		stderr: 'pipe',
	},
})

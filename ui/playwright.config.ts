// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  // `playwright.cluster.config.ts` owns the cluster suite: it takes no `page`,
  // so here it would only ever skip (no Bee node in the browser job) or
  // double-run (locally, where both configs are used).
  testIgnore: '**/gnosis-cluster.test.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'html',
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  use: {
    baseURL: 'http://localhost:5500',
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
            '--disable-popup-blocking',
          ],
        },
      },
    },
  ],

  webServer: [
    {
      command: 'pnpm dev',
      port: 5500,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm -C .. dev:demo',
      port: 3500,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})

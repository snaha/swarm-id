// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from '@playwright/test'

/**
 * The three-device partition scenarios (`tests/three-devices.test.ts`): three
 * browser contexts of one account sharing two write partitions, driven through
 * the demo the way a person drives it. Minutes per run by construction — the
 * lease TTL, the idle yield and the beacon grace are each 30 s and the suite
 * waits them out — so it is not part of `pnpm test:e2e`. It runs on its own
 * workflow (`.github/workflows/three-devices.yml`): on a PR that touches the
 * lease seams, nightly on main, and on demand. Locally:
 *
 *   pnpm dev:local                      # cluster + chain + solver + apps
 *   pnpm test:devices                   # chromium
 *   DEVICE_BROWSERS=chromium,firefox,webkit pnpm test:devices
 *
 * One worker: every test in the file shares the same three devices.
 */
const BROWSERS = (process.env.DEVICE_BROWSERS ?? 'chromium').split(',')

/** The whole cycle, with the TTL and idle waits inside it. */
const TEST_TIMEOUT_MS = 6 * 60 * 1000

export default defineConfig({
  testDir: './tests',
  testMatch: '**/three-devices.test.ts',
  fullyParallel: false,
  workers: 1,
  globalSetup: './tests/global-setup-devices.ts',
  // The list is what the job log shows, verdicts and skip reasons alike; the
  // HTML report is what gets uploaded when something fails.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: TEST_TIMEOUT_MS,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://localhost:5500',
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: BROWSERS.map((name) => ({
    name,
    use: {
      ...devices[
        name === 'firefox'
          ? 'Desktop Firefox'
          : name === 'webkit'
            ? 'Desktop Safari'
            : 'Desktop Chrome'
      ],
      ...(name === 'chromium'
        ? { launchOptions: { args: ['--disable-popup-blocking', '--no-sandbox', '--disable-gpu'] } }
        : {}),
    },
  })),
  webServer: [
    {
      command: 'pnpm dev',
      port: 5500,
      reuseExistingServer: true,
      timeout: 30000,
    },
    {
      command: 'pnpm -C .. dev:demo',
      port: 3500,
      reuseExistingServer: true,
      timeout: 30000,
    },
    {
      command: 'pnpm -C .. dev:signaling',
      url: 'http://localhost:5520/healthz',
      reuseExistingServer: true,
      timeout: 30000,
    },
  ],
})

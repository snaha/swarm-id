// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from '@playwright/test'

/**
 * Enough to overlap the chain-bound suites, not enough to pile swaps on top of
 * each other: a purchase that has to buy its own BZZ quotes SushiSwap and then
 * reverts if the fill drifts more than 0.5%, and the local pool is thin.
 *
 * Each worker signs its funding from its slot's own address (`tests/worker-faucet.ts`).
 * This is also the number of faucets `global-setup.ts` stocks, and no
 * `parallelIndex` in any project ever reaches past it.
 */
const WORKERS = 3

/**
 * Stop the run ourselves, in front of the workflow's 30-minute job cap: a
 * runner cancellation uploads nothing, while Playwright stopping first fails
 * the job with the HTML report and traces intact.
 */
const GLOBAL_TIMEOUT_MS = 20 * 60 * 1000

/** Chain-bound tests cost minutes each. */
const MAX_FAILURES = 5

/**
 * The spec that mutates state the whole chain shares — it removes the EIP-7702
 * delegate — so nothing that pays on chain may be running beside it. Its own
 * project, ordered after the parallel one, is the only way Playwright can
 * express that: `mode: 'serial'` orders tests within a file, never files
 * against each other.
 */
const SERIAL_SPEC = '**/drive-onchain-serial.test.ts'

/**
 * The suite that needs the proxy iframe's storage genuinely partitioned, which
 * an ordinary chromium project cannot give it — see `PARTITIONING_ARGS`.
 */
const PARTITIONED_SPEC = '**/bus-propagation.test.ts'

const CHROMIUM_ARGS = [
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-popup-blocking',
]

/**
 * Playwright's own defaults **disable** `ThirdPartyStoragePartitioning`, so a
 * plain chromium project measures the unpartitioned path even when the origins
 * are cross-site — a partition test that skips this passes while proving
 * nothing. Chromium keeps the LAST occurrence of a switch, so re-sending
 * `--disable-features` without that one entry is what turns it back on.
 *
 * The list is Playwright 1.57's defaults, read back over CDP with
 * `Browser.getBrowserCommandLine`, minus `ThirdPartyStoragePartitioning`. It
 * will go stale on a Playwright upgrade, and that is survivable only because
 * `bus-propagation.test.ts` opens by proving the iframe really is partitioned:
 * a drifted list fails there rather than silently downgrading the suite.
 */
const PARTITIONING_ARGS = [
  '--disable-features=AcceptCHFrame,AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,Translate,AutoDeElevate,RenderDocument,OptimizationHints',
  '--enable-features=ThirdPartyStoragePartitioning',
]

/** One browser, three schedules: the projects differ in what they run. */
const CHROMIUM = {
  ...devices['Desktop Chrome'],
  launchOptions: { args: CHROMIUM_ARGS },
}

export default defineConfig({
  testDir: './tests',
  // Files run in parallel; tests within one keep their order, which several
  // suites rely on.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: WORKERS,
  globalSetup: './tests/global-setup.ts',
  globalTimeout: process.env.CI ? GLOBAL_TIMEOUT_MS : undefined,
  maxFailures: process.env.CI ? MAX_FAILURES : undefined,
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
      testIgnore: [SERIAL_SPEC, PARTITIONED_SPEC],
      use: CHROMIUM,
    },
    {
      name: 'chromium-partitioned',
      testMatch: PARTITIONED_SPEC,
      use: {
        ...CHROMIUM,
        launchOptions: { args: [...CHROMIUM_ARGS, ...PARTITIONING_ARGS] },
      },
    },
    {
      // `dependencies` holds this back until every test above has finished, so
      // the delegate is only ever missing while nothing else is on the chain.
      // A failed dependency skips this project.
      name: 'chromium-serial',
      testMatch: SERIAL_SPEC,
      dependencies: ['chromium'],
      use: CHROMIUM,
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
    {
      // The account bus. `busSignalingUrl()` falls back to ws://localhost:5520
      // in dev, so without this the socket never opens and every delta goes
      // silently nowhere — which reads exactly like a healthy run.
      command: 'pnpm -C .. dev:signaling',
      url: 'http://localhost:5520/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})

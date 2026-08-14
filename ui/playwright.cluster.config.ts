// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from '@playwright/test'

/**
 * The suite that talks to a running Bee cluster rather than to the app.
 *
 * `gnosis-cluster.test.ts` takes no `page` — it drives bee-js and the chain
 * directly — so it needs neither a browser nor the dev servers the main config
 * starts. Splitting it out lets it run wherever a cluster already exists (CI's
 * integration job) instead of only where browsers do, which is why it spent so
 * long skipping.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/gnosis-cluster.test.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  workers: 1,
  reporter: 'list',
  // A purchase, an ingestion wait and a pushsync round-trip, on chain time.
  timeout: 180_000,
  expect: { timeout: 120_000 },
})

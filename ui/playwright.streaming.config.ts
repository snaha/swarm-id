// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from '@playwright/test'

import devicesConfig from './playwright.devices.config'

/**
 * The streaming transfers across the identity iframe
 * (`tests/streaming-transfer.test.ts`): one device of the device rig and a
 * funded drive, so the device config's servers, global setup and browsers,
 * with only this suite in it. It runs on its own workflow
 * (`.github/workflows/streaming-transfer.yml`): on a PR that touches the
 * streaming code, nightly on main, before every npm publish, and on demand.
 * Locally:
 *
 *   pnpm dev:local                      # cluster + chain + solver + apps
 *   pnpm test:streaming                 # chromium
 */
export default defineConfig({
  ...devicesConfig,
  testMatch: '**/streaming-transfer.test.ts',
})

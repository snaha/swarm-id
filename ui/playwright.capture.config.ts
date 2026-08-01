// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import base from './playwright.config'

/**
 * Config for the screenshot capture script (`tests/*.capture.ts`), which is
 * deliberately outside the test suite's `*.test.ts` glob — it drives the real
 * on-chain flows to produce PR / design-review images, not assertions.
 *
 *   pnpm exec playwright test --config=playwright.capture.config.ts
 */
export default {
  ...base,
  testMatch: '**/*.capture.ts',
  // The captures chain several on-chain confirmations end to end.
  timeout: 400_000,
}

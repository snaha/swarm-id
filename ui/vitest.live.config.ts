// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config'

/**
 * The suites that talk to a real hosted service — today, Relay's quote API.
 *
 * Separate from `pnpm test` because it needs the internet, and `check:all` must
 * stay runnable offline. A contract check whose service cannot be reached
 * reports SKIPPED rather than passing, so an offline run says "not checked" out
 * loud instead of looking like "checked and fine". Under CI the suite also
 * asserts reachability, so an outage there is a red build on purpose.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})

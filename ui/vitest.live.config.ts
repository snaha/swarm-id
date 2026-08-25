// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config'

/**
 * The suites that talk to a real hosted service — today, Relay's quote API.
 *
 * Separate from `pnpm test` because it needs the internet, and `check:all` must
 * stay runnable offline. The suites skip themselves when the service cannot be
 * reached, so a green run offline means "not checked", not "checked and fine".
 */
export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config"

/**
 * Config for integration tests that run the library against a live local Bee
 * node (see lib/test/integration). Kept separate from the default unit-test
 * config so these tests are opt-in (`pnpm test:integration`) and never run in
 * normal CI without a cluster.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    // Buys one usable stamp before any file runs and shares it via inject(),
    // so the stamp warmup is paid once for the whole suite.
    globalSetup: ["./test/integration/global-setup.ts"],
    // Live Bee ops (stamp warmup, uploads) are slower than unit tests.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})

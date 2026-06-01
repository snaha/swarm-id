// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config"

/**
 * Config for integration tests that run against a live local Bee cluster
 * (see lib/test/cluster). Kept separate from the default unit-test config so
 * these tests are opt-in (`pnpm test:cluster`) and never run in normal CI.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/cluster/**/*.cluster.test.ts"],
    // Cluster ops (stamp warmup, uploads) are slower than unit tests.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})

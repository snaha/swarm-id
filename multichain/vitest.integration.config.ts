// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config"

/**
 * Integration tests against the bee-compose anvil chain (RPC :9545). Opt-in
 * (`pnpm test:integration`) and skipped automatically when no chain is
 * reachable, so they never break the default unit-test run or CI.
 *
 * Start the chain with `pnpm dev:bee:detach` from the repo root (the anvil
 * node comes up with the cluster; the Bee nodes themselves are not needed).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    // Anvil mines on a 5s cadence and the lifecycle chains several
    // transactions, each awaited to a receipt.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})

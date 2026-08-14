// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config"

/**
 * Tests against the baked local chain (`pnpm dev:chain`), which carries a real
 * BZZ market and the PostageStamp the cluster follows. Opt-in and skipped
 * automatically when no chain is reachable.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/fork/**/*.test.ts"],
    // The chain mines on a block cadence, so a purchase spans several
    // confirmations.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})

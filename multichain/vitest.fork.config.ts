// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config"

/**
 * Tests against an anvil fork of Gnosis mainnet (`pnpm dev:fork`), where the
 * real PostageStamp, BZZ token and SushiSwap pools exist. Opt-in and skipped
 * automatically when no fork is reachable.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/fork/**/*.test.ts"],
    // A fork mines instantly but every call still round-trips to the upstream
    // RPC the first time it touches unseen state.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config"

/**
 * Config for the opt-in LIVE suite (lib/test/live): scenarios run against a real
 * remote Bee backend (default = the public gateway) + funded postage batch
 * configured via a gitignored `.env` (see test/live/README.md).
 *
 * Kept separate from the default unit config AND from the local-cluster
 * `test:integration` config so it is NEVER run by CI — invoke it explicitly
 * with `pnpm test:live`. Without a `.env` every suite self-skips.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/live/**/*.test.ts"],
    setupFiles: ["./test/live/setup.ts"],
    // These flows wait out gateway propagation (~70s between publishes; minutes
    // of fold polling), so a single scenario can run for several minutes.
    testTimeout: 600_000,
    hookTimeout: 120_000,
    // The scenarios mutate one shared account over Swarm; run files serially so
    // independent suites don't contend on the batch or each other's feeds.
    fileParallelism: false,
  },
})

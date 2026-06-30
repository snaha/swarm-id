// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The suite has several ECDSA-signing / encryption-heavy tests (partition
    // SOC writes, Merkle-tree upload round-trips). They run in 1–3s standalone,
    // but vitest runs all files in parallel worker processes and CPU
    // oversubscription has been observed to inflate them ~5×, blowing the 5s
    // default and flaking the suite. A generous global timeout absorbs the
    // contention while still catching a genuinely hung test.
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "dist/", "**/*.test.ts"],
    },
  },
})

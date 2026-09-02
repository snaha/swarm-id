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
    // TRADEOFF: 6× the default also raises the ceiling under which a genuine
    // per-test perf regression could hide. If a test starts routinely taking
    // seconds in ISOLATION (not just under parallel contention), fix the test —
    // don't lean on this headroom. Revisit lowering it if CI CPU improves.
    // And do not undercut it with a per-test `{ timeout }`: a 10 s cap on a
    // 2 s signing loop flaked under the full suite while every neighbour had
    // 30 s (#585). A test that needs a bound needs it above this one.
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "dist/", "**/*.test.ts"],
    },
  },
})

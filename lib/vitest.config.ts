// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The suite has several ECDSA-signing / encryption-heavy tests (partition
    // SOC writes, Merkle-tree upload round-trips). They are CPU-bound — the Bee
    // client is mocked, so nothing here waits on a socket — and vitest runs all
    // files in parallel worker processes, so what they cost is a function of
    // how oversubscribed the machine is.
    //
    // Measured 2026-09-04 (#585), same tests on two machines — the spread
    // between the columns IS the finding, so read it as a range, not a number:
    //
    //                                             isolated  14-core  8-core M1
    //                                                        idle     loaded
    //   partition-lease "concurrent SOC writers"     3.4s    11.1s     24.0s
    //   roundtrip       "large index counts"         4.2s    10.5s     16.1s
    //   partition-lease "heartbeat RELOCATES"        3.3s    10.1s     12.3s
    //   roundtrip       "50 sequential updates"      2.2s    11.1s      8.0s
    //
    // The loaded column is a developer machine at load average ~10 with 68
    // other node processes — the kind of machine #585 was filed from. It puts
    // the heaviest test 1.25× under this budget, where the idle machine left
    // 2.7×. Neither is the machine that matters most: CI runs on a 2-vCPU
    // `ubuntu-latest` runner, which is UNMEASURED and slower than either.
    //
    // So: the headroom is whatever the machine decides, and the number here is
    // sized for the worst one seen rather than the best. A generous global
    // timeout absorbs the contention while still catching a genuinely hung
    // test.
    // TRADEOFF: 6× the default also raises the ceiling under which a genuine
    // per-test perf regression could hide. If a test starts routinely taking
    // seconds in ISOLATION (not just under parallel contention), fix the test —
    // don't lean on this headroom. Lowering it means re-measuring the table
    // above on a LOADED machine, not guessing: by the idle column it would
    // flake below ~20s, and the loaded column had already reached 24s.
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

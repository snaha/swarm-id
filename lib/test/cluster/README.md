<!--
Copyright 2026 The Swarm Authors. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Cluster integration tests

Integration tests that exercise the library's real Swarm operations
(`uploadData`, `downloadDataWithChunkAPI`, …) against a **live local Bee
cluster** started with [`@snaha/bee-compose`](https://www.npmjs.com/package/@snaha/bee-compose).

This is the POC for [#302](https://github.com/snaha/swarm-id/issues/302):
replacing manual testing with automated round-trips against a real node.

## Running

From the repo root, start the cluster, then run the suite:

```bash
pnpm dev:bee:detach                       # start queen + 1 worker (Docker)
pnpm --filter @snaha/swarm-id test:cluster
```

The suite is **skipped automatically** when no cluster is reachable at
`http://localhost:1633`, so it never breaks the default unit-test run
(`pnpm test`) or CI.

## How it works

- Tests run under a dedicated config (`lib/vitest.cluster.config.ts`) and live
  outside `src/`, so they are opt-in and excluded from build/typecheck/lint.
- `cluster.ts` provides helpers: cluster reachability, buying/reusing a usable
  postage stamp, and building a bee-js `Stamper` from the queen's well-known
  dev key (uploads in Node without the browser-only proxy machinery).
- A usable stamp is reused across the whole run when present, so one cluster
  serves all tests. Each test uploads freshly randomised data, so tests are
  independent.

## Next steps

This POC covers plain + encrypted data round-trips. Natural extensions:
SOC, sequential/epoch feeds, ACT, manifests, subsidised-gateway mode, and
error cases — plus wiring `test:cluster` into a CI job that boots bee-compose.

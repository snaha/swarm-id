<!--
Copyright 2026 The Swarm Authors. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Integration tests (live Bee)

Integration tests that exercise the **library's** real Swarm operations
(`uploadData`, `downloadDataWithChunkAPI`, …) against a **live local Bee node**
started with [`@snaha/bee-compose`](https://www.npmjs.com/package/@snaha/bee-compose).

These test the library only — they call its functions directly against a real
Bee node. The full dApp → popup → iframe flow is exercised separately against
the identity UI (`ui/`) and the demo dApp. Unit tests in `src/` mock Bee;
these do not.

Originated as the POC for [#302](https://github.com/snaha/swarm-id/issues/302):
replacing manual testing with automated round-trips against a real node.

## Running

From the repo root, start the cluster, then run the suite:

```bash
pnpm dev:cluster:start   # start queen + 3 full workers (Docker)
pnpm --filter @snaha/swarm-id test:integration
```

The suite is **skipped automatically** when no cluster is reachable at
`http://localhost:1633`, so it never breaks a local unit-test run.

It is not optional in CI: `integration-tests.yml` starts a cluster and runs
`pnpm --filter @snaha/swarm-id test:integration` on every push to `main` and
every pull request touching `lib/**`, so these tests gate merges like any other.

## How it works

- Tests run under a dedicated config (`lib/vitest.integration.config.ts`) and
  live outside `src/`, so the default unit-test run does not pick them up and the
  rollup build does not bundle them. They **are** typechecked, linted and
  formatted with the rest of the package (`tsconfig.check.json`, `eslint.config.js`).
- `cluster.ts` provides helpers: cluster reachability, buying/reusing a usable
  postage stamp, and building a bee-js `Stamper` from the queen's well-known
  dev key (uploads in Node without the browser-only proxy machinery).
- `global-setup.ts` (Vitest `globalSetup`) buys (or reuses) **one** usable
  postage stamp before any test file runs and shares its batch id with every
  file via `provide`/`inject`. This makes the ~minute-long stamp warmup a
  one-time cost for the whole run instead of per file.

### Adding a new integration test file

Reuse the shared stamp — do not buy your own:

```ts
import { inject, beforeAll } from "vitest"
import { isClusterReachable, createClusterContext } from "./cluster"

const clusterReachable = await isClusterReachable()

describe.skipIf(!clusterReachable)("my feature", () => {
  let bee, target
  beforeAll(() => {
    ;({ bee, target } = createClusterContext(inject("clusterBatchId")))
  })
  // ...use uploadData/uploadSOC/etc. with `target`, download with `bee`
})
```

Each test should use a unique data set (random or name-derived) so files stay
independent and can run in any order against the shared node.

## Next steps

Covered so far: plain and encrypted data round-trips (`round-trip.test.ts`),
chunk-boundary sizes (`data-sizes.test.ts`), and large plain uploads read back
through Bee's native `/bytes` as an interop proof (`large-plain-upload.test.ts`).

Natural extensions: SOC, sequential/epoch feeds, ACT, manifests, and
subsidised-gateway mode. These need network push and retrieval to work, which is
why they waited on a multi-node cluster; `dev:cluster:start` has run queen + 3
full workers with public reachability since bee-compose 0.1.4, so the original
blocker is gone and the gap is just unwritten tests.

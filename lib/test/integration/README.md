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

The suite **fails** when no cluster is reachable at `http://localhost:1633`,
naming the command to start one. It is a precondition, not a condition: `pnpm
test` is the command that runs without services, and a run that checked nothing
must not be able to report the same colour as a run that did. Nothing here is
skipped, so a local unit-test run is unaffected either way.

It is not optional in CI: `integration-tests.yml` starts a cluster and runs
`pnpm --filter @snaha/swarm-id test:integration` on every push to `main` and
every pull request touching `lib/**`, so these tests gate merges like any other.

## How it works

- Tests run under a dedicated config (`lib/vitest.integration.config.ts`) and
  live outside `src/`, so the default unit-test run does not pick them up and the
  rollup build does not bundle them. They **are** typechecked, linted and
  formatted with the rest of the package (`tsconfig.check.json`, `eslint.config.js`).
  Being opt-in to _run_ is what lets them be unconditional: the two commands
  differ by what they require, not by what they silently decline to check.
- `cluster.ts` provides helpers: cluster reachability, buying/reusing a usable
  postage stamp, and building a bee-js `Stamper` from the queen's well-known
  dev key (uploads in Node without the browser-only proxy machinery).
- `global-setup.ts` (Vitest `globalSetup`) buys (or reuses) **one** usable
  postage stamp before any test file runs and shares its batch id with every
  file via `provide`/`inject`. This makes the ~minute-long stamp warmup a
  one-time cost for the whole run instead of per file.
- `gateway.ts` then starts upstream's `ethersphere/gateway-proxy` in front of
  the same queen, stamping with that same batch, and stops it when the run
  ends. Both upload modes that go through a gateway run against it:
  - **subsidised**: the one upload path the library does not stamp itself. It
    POSTs bare chunks and SOCs and the gateway injects `swarm-postage-batch-id`.
  - **user stamp via a gateway**, the production default: the stamper target
    with its `Bee` pointed at the gateway, so every chunk and SOC carries the
    user's own `swarm-postage-stamp`. The gateway adds its batch id to these
    too and Bee prefers the stamp, so a round trip cannot tell whose stamp was
    used. A stamp signed by a key that does not own the batch can: Bee refuses
    it, and the gateway must hand that refusal back rather than store the
    chunk under its own batch.

  Mocking that contract would only ever confirm our own assumptions back to
  us, so the real server runs. Every read goes to the queen, never back
  through the gateway.

  It needs nothing beyond Docker, which the cluster already requires — so with
  a cluster up, a gateway that will not start is a real breakage, and the setup
  **fails**, exactly as a missing cluster does. Nothing in this suite skips: a
  skip reports a breakage in the one colour CI cannot tell from success.

### Adding a new integration test file

Reuse the shared stamp — do not buy your own:

```ts
import { inject, beforeAll } from "vitest"
import { createClusterContext } from "./cluster"

describe("my feature", () => {
  let bee, target
  beforeAll(() => {
    ;({ bee, target } = createClusterContext(inject("clusterBatchId")))
  })
  // ...use uploadData/uploadSOC/etc. with `target`, download with `bee`
})
```

Each test should use a unique data set (random or name-derived) so files stay
independent and can run in any order against the shared node.

## Coverage

- Plain and encrypted data round-trips against the queen (`round-trip.test.ts`)
- Chunk-boundary sizes (`data-sizes.test.ts`)
- Large plain uploads read back through Bee's native `/bytes`, as an interop
  proof (`large-plain-upload.test.ts`)
- Subsidised mode through the gateway: plain, multi-chunk and SOC
  (`subsidised-round-trip.test.ts`)
- User stamp through the gateway: plain, multi-chunk, encrypted and SOC, plus
  a stamp the batch owner did not sign being refused at the queen and through
  the gateway alike (`user-stamp-gateway.test.ts`)

### Not covered

- **Tags through a gateway.** gateway-proxy does not proxy `/tags`, so
  `POST /tags` answers 404 and `tryCreateTag` falls back to uploading without
  one. Every gateway upload here takes that fallback, so a dApp behind a
  gateway gets no tag for an upload. The suite proves the fallback, not tag
  tracking.
- **CORS.** Node's `fetch` never sends a preflight. gateway-proxy 0.17.0
  hard-codes its `Access-Control-Allow-Headers`, and `swarm-postage-stamp` is
  not on the list, so a browser's user-stamp upload through this image fails
  its preflight. Subsidised uploads are unaffected. A browser test of either mode belongs to
  the e2e step of [#831](https://github.com/snaha/swarm-id/issues/831).

## Next steps

Natural extensions: sequential/epoch feeds, ACT, and manifests. These need
network push and retrieval to work, which is why they waited on a multi-node
cluster; `dev:cluster:start` has run queen + 3 full workers with public
reachability since bee-compose 0.1.4, so the original blocker is gone and the
gap is just unwritten tests.

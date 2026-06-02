// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vitest globalSetup for the cluster integration suite.
 *
 * Runs once before any test file. When a local Bee cluster is reachable it
 * buys (or reuses) a single usable postage stamp and shares its batch id with
 * every test file via `provide`/`inject`. This keeps the ~minute-long stamp
 * warmup a one-time cost for the whole run instead of paying it per file.
 *
 * When no cluster is reachable it provides nothing; the test files detect this
 * independently and skip (see `isClusterReachable` usage in *.cluster.test.ts).
 */

import type { GlobalSetupContext } from "vitest/node"
import { isClusterReachable, buyUsableStamp } from "./cluster"

export default async function setup({ provide }: GlobalSetupContext) {
  if (!(await isClusterReachable())) {
    console.warn(
      "[cluster] No local Bee cluster reachable at http://localhost:1633 — cluster integration tests will be skipped. Run `pnpm dev:bee:detach` to enable them.",
    )
    return
  }

  console.log(
    "[cluster] Acquiring a usable postage stamp (shared by all test files)...",
  )
  const batchId = await buyUsableStamp()
  console.log(`[cluster] Using batch ${batchId}`)
  provide("clusterBatchId", batchId)
}

declare module "vitest" {
  interface ProvidedContext {
    clusterBatchId: string
  }
}

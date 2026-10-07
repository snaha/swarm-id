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
 * It also owns the services the suite needs, and refuses the run when they are
 * not there. Nothing in `test/integration` skips: `pnpm test` is the command
 * that runs without services, so a run of THIS one that checked nothing must
 * not be able to report the same colour as a run that did.
 */

import type { TestProject } from "vitest/node"
import { QUEEN_URL, isClusterReachable, buyUsableStamp } from "./cluster"
import { GATEWAY_URL, startGatewayProxy } from "./gateway"

export default async function setup({ provide }: TestProject) {
  if (!(await isClusterReachable())) {
    // A precondition, not a condition. `pnpm test` is the command that runs
    // without services; this one exists to check them, and a run that checked
    // nothing must not be able to report the same colour as a run that did.
    throw new Error(
      `[cluster] No local Bee cluster reachable at ${QUEEN_URL}.\n` +
        "Start one with `pnpm dev:cluster:start`, or run `pnpm test` for the suite that needs no services.",
    )
  }

  console.log(
    "[cluster] Acquiring a usable postage stamp (shared by all test files)...",
  )
  const batchId = await buyUsableStamp()
  console.log(`[cluster] Using batch ${batchId}`)
  provide("clusterBatchId", batchId)

  // Subsidised mode uploads to a gateway that stamps for it, so covering it
  // needs a real one in front of the same queen. Started here rather than from
  // a CI step, so the suite brings up everything it needs on its own and CI
  // needs no wiring that could drift from it.
  const gateway = await startGatewayProxy(batchId)
  if (!gateway) {
    // Hard failure, not a skip. Reaching here means the cluster answered, so
    // Docker is running by definition — bee-compose IS Docker. A gateway that
    // will not start under those conditions is a real breakage, and a skip
    // would report it in the one colour CI cannot tell from success.
    throw new Error(
      "[gateway] The cluster is up but the subsidised gateway would not start. " +
        "See the warning above for why. Fix it, or run the unit suite (`pnpm test`) instead.",
    )
  }
  console.log(`[gateway] Subsidised gateway ready at ${GATEWAY_URL}`)

  return async () => {
    await gateway.stop()
  }
}

declare module "vitest" {
  interface ProvidedContext {
    clusterBatchId: string
  }
}

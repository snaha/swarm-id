// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vitest globalSetup for the fork suite.
 *
 * Owns the one precondition every file here shares — a reachable Gnosis fork —
 * and refuses the run without it. `pnpm test` is the command that runs without
 * services; this one exists to check them, so a run of it that checked nothing
 * must not be able to report the same colour as a run that did. Nothing in
 * `test/fork` skips.
 */

import { FORK_RPC_URL, isGnosisForkReachable } from "./fork"

export default async function setup(): Promise<void> {
  if (await isGnosisForkReachable()) {
    return
  }
  throw new Error(
    `[fork] No Gnosis fork reachable at ${FORK_RPC_URL}.\n` +
      "Start one with `pnpm dev:chain:detach`, or run `pnpm test` for the suite that needs no services.",
  )
}

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Runs once, before any worker starts.
 *
 * Its only job is to put each worker slot in funds, so that the suites can run
 * in parallel without sharing a sender — see `worker-faucet.ts` for why that
 * matters.
 *
 * `config.workers` is the whole range: slots are addressed by `parallelIndex`,
 * which stays inside it however many workers a run starts and whichever project
 * they are serving.
 *
 * A missing chain is not an error here: the suites that need one skip
 * themselves, and the ones that do not still deserve to run.
 */
import type { FullConfig } from '@playwright/test'

import { CHAIN_RPC_URL, chainReachable } from './helpers'
import { stockWorkerFaucets } from './worker-faucet'

export default async function globalSetup(config: FullConfig): Promise<void> {
  if (!(await chainReachable())) {
    return
  }
  await stockWorkerFaucets(config.workers, CHAIN_RPC_URL)
}

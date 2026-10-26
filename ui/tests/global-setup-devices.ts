// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { PrivateKey } from '@ethersphere/bee-js'
import type { FullConfig } from '@playwright/test'
import { MultichainClient, gnosisMainnetSettings } from '@swarm-id/multichain'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { CHAIN_RPC_URL, chainReachable } from './helpers'
import { stockWorkerFaucets, workerFaucetKey } from './worker-faucet'

/**
 * What one drive costs a run of the device suites: the smallest drive at 30
 * days is ~0.65 BZZ, and whatever is left over is stranded on that signer for
 * good — so not the everyday 3 BZZ. The three-device suite buys one, the
 * two-drive suite two.
 */
export const DEVICES_RUN_BZZ_PLUR = 10n ** 16n // 1 BZZ

/** How many worker slots the everyday config stocks (`WORKERS` there). */
const STOCKED_SLOTS = 3

/** The first worker slot still holding what one run of this suite spends. */
export async function stockedSlot(
  bzzPlur: bigint = DEVICES_RUN_BZZ_PLUR,
): Promise<number | undefined> {
  const client = new MultichainClient(gnosisMainnetSettings({ rpcUrls: [CHAIN_RPC_URL] }))
  for (let slot = 0; slot < STOCKED_SLOTS; slot++) {
    const address = new PrivateKey(workerFaucetKey(slot)).publicKey().address().toChecksum()
    if ((await client.getBzzBalance(address as `0x${string}`)) >= bzzPlur) return slot
  }
  return undefined
}

/**
 * A suite buys one or two drives per run. The everyday setup tops every slot back up
 * to its full float from the chain's faucet and fails outright once that
 * faucet runs low — after a dozen runs on one baked chain, which is exactly
 * the cadence of a suite meant to be run by hand. Any slot that still holds
 * one run's worth is good enough here; the full stocking is only attempted
 * when none does.
 */
/** Where a suite keeps its run's account (in the project's output dir), so a worker
 *  restarted after a failure reuses the drives instead of buying more. */
export const THREE_DEVICES_SEED_FILE = 'three-devices-seed.json'
export const TWO_DRIVES_SEED_FILE = 'two-drives-seed.json'

export default async function globalSetup(config: FullConfig): Promise<void> {
  // One account per run: the seed survives worker restarts inside a run, not
  // across runs, or the roster grows by three devices every time.
  for (const seed of [THREE_DEVICES_SEED_FILE, TWO_DRIVES_SEED_FILE]) {
    rmSync(join(config.projects[0].outputDir, seed), { force: true })
  }
  if (!(await chainReachable())) return
  if ((await stockedSlot()) !== undefined) return
  await stockWorkerFaucets(config.workers, CHAIN_RPC_URL)
}

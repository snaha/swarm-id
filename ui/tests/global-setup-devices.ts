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
 * What one run of the three-device suite funds the account's signer with.
 * The smallest drive at 30 days costs ~0.65 BZZ, and whatever is left over is
 * stranded on that signer for good — so not the everyday 3 BZZ.
 */
export const DEVICES_RUN_BZZ_PLUR = 10n ** 16n // 1 BZZ

/** How many worker slots the everyday config stocks (`WORKERS` there). */
const STOCKED_SLOTS = 3

/** The first worker slot still holding what one run of this suite spends. */
export async function stockedSlot(): Promise<number | undefined> {
  const client = new MultichainClient(gnosisMainnetSettings({ rpcUrls: [CHAIN_RPC_URL] }))
  for (let slot = 0; slot < STOCKED_SLOTS; slot++) {
    const address = new PrivateKey(workerFaucetKey(slot)).publicKey().address().toChecksum()
    if ((await client.getBzzBalance(address as `0x${string}`)) >= DEVICES_RUN_BZZ_PLUR) return slot
  }
  return undefined
}

/**
 * The suite buys ONE drive per run. The everyday setup tops every slot back up
 * to its full float from the chain's faucet and fails outright once that
 * faucet runs low — after a dozen runs on one baked chain, which is exactly
 * the cadence of a suite meant to be run by hand. Any slot that still holds
 * one run's worth is good enough here; the full stocking is only attempted
 * when none does.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  // One account per run: the seed survives worker restarts inside a run, not
  // across runs, or the roster grows by three devices every time.
  rmSync(join(config.projects[0].outputDir, 'three-devices-seed.json'), { force: true })
  if (!(await chainReachable())) return
  if ((await stockedSlot()) !== undefined) return
  await stockWorkerFaucets(config.workers, CHAIN_RPC_URL)
}

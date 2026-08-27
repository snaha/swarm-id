// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * A faucet per Playwright worker SLOT.
 *
 * Funding a test account is a transfer, and a transfer needs a nonce. The
 * chain's own faucet is a single address, so two workers funding at the same
 * moment read the same pending nonce and one of the two transfers is thrown
 * away — silently, as a test that mysteriously has no money. Each slot signs
 * from its own address instead, stocked once before any worker starts
 * (`global-setup.ts`).
 *
 * The slot is `test.info().parallelIndex`, never `workerIndex`. Only
 * `parallelIndex` stays inside `0 … config.workers - 1`, which is exactly the
 * range stocked here: `workerIndex` GROWS every time a worker is replaced after
 * a failure, so the replacement would fund from an address nobody ever stocked
 * and every funded test it went on to pick up would die on gas. A retry shares
 * the float with the attempt it replaced, which the float is sized to absorb.
 *
 * The keys are derived from the slot rather than generated, so a long-lived
 * local chain reuses the same floats run after run. A fresh one is only stocked
 * once; a used one is topped back up to the float, which is what keeps a chain
 * that has been up for days from stranding the faucet's BZZ in a new set of
 * throwaway addresses every run.
 */
import { MultichainClient, gnosisMainnetSettings } from '@swarm-id/multichain'
import { DEV_FAUCET_ADDRESS, anvilSetBalance, fundLocalAccount } from '@swarm-id/multichain/dev'
import { keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * The worker's xDAI: what it hands on to the accounts it funds, plus the gas
 * for doing so. Minted rather than transferred, so it costs the chain's faucet
 * nothing and needs no transaction — which is also why it can be generous.
 */
const WORKER_XDAI_WEI = 5n * 10n ** 18n // 5 xDAI

/**
 * BZZ each worker keeps to hand out — twelve fundings at the 3 BZZ a purchase
 * takes (`DRIVE_FUNDING` in `helpers.ts`).
 *
 * Sized for the worst distribution, not the average one: work is handed out a
 * FILE at a time, so nothing stops one worker drawing every funding suite. The
 * suites ask for eight fundings between them today, and a float that merely
 * covers the average leaves a worker empty mid-run — which surfaces as a
 * reverted transfer inside whichever test was unlucky, not as a budget
 * problem. Add a funding suite and this is the number to raise.
 *
 * The chain's faucet is baked with 250 BZZ, so stocking a handful of workers
 * from a fresh one is affordable; a long-lived one only replaces what was
 * spent, since the addresses are stable.
 */
const WORKER_BZZ_FLOAT_PLUR = 36n * 10n ** 16n // 36 BZZ (16 decimals)

/** Domain separator, so these addresses collide with nothing else on the chain. */
const KEY_PREFIX = 'swarm-id e2e worker faucet '

/**
 * The key slot `index` (a `parallelIndex`) funds from. Deterministic: the same
 * slot gets the same address on every run against the same chain.
 */
export function workerFaucetKey(index: number): `0x${string}` {
  return keccak256(toHex(`${KEY_PREFIX}${index}`))
}

function workerFaucetAddress(index: number): `0x${string}` {
  return privateKeyToAccount(workerFaucetKey(index)).address
}

/**
 * Put every worker slot in funds, before any of them starts.
 *
 * `slotCount` is `config.workers`: the number of slots, and the bound every
 * `parallelIndex` stays under however many workers the run ends up starting.
 *
 * Runs in the single global-setup process, so the transfers out of the chain's
 * faucet are sequential by construction — the very contention this exists to
 * remove from the workers.
 */
export async function stockWorkerFaucets(slotCount: number, rpcUrl: string): Promise<void> {
  const settings = gnosisMainnetSettings({ rpcUrls: [rpcUrl] })
  const client = new MultichainClient(settings)

  for (let index = 0; index < slotCount; index++) {
    const address = workerFaucetAddress(index)
    // Minting is instant and nonce-free, so this never queues behind anything.
    await anvilSetBalance(rpcUrl, address, WORKER_XDAI_WEI)
    const held = await client.getBzzBalance(address)
    if (held >= WORKER_BZZ_FLOAT_PLUR) {
      continue
    }
    const shortfall = WORKER_BZZ_FLOAT_PLUR - held
    const available = await client.getBzzBalance(DEV_FAUCET_ADDRESS)
    if (available < shortfall) {
      // Loud here rather than as a reverted transfer inside an unrelated test.
      throw new Error(
        `The chain's faucet has ${available} PLUR left, ${shortfall} short of stocking ` +
          `slot ${index}. Restart the chain from its baked snapshot ` +
          `(pnpm dev:cluster:start --fresh) to refill it.`,
      )
    }
    await fundLocalAccount({ to: address, xdai: 0n, bzzPlur: shortfall }, settings)
  }
}

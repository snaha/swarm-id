// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * What the on-chain drive suites share: the chain probe, an account holding a
 * drive whose batch it owns on that chain, and reading that drive back.
 *
 * A plain module rather than one of the specs, because a spec imported from a
 * spec would register its tests a second time.
 */
import { type Page, expect } from '@playwright/test'

import { CHAIN_RPC_URL, chainReachable, completeCreateFlow } from './helpers'

// Re-exported under its old name: `drive-onchain-serial.test.ts` imports it
// from here, and the two files are owned separately — the shared probe and
// URL live once, in `helpers.ts`, and this keeps their import untouched.
export const ANVIL_RPC_URL = CHAIN_RPC_URL
const BEE_NODE_URL = 'http://localhost:1633/'
/** On-chain work spans several 5s-block confirmations. */
export const ONCHAIN_TIMEOUT_MS = 120_000
/** The depth `/dev`'s Create-drive action buys. */
const DRIVE_DEPTH = 20

/** Probed once per worker, so each suite can skip itself rather than fail. */
export const chainUp = await chainReachable(ANVIL_RPC_URL)

/** The stored drive's on-chain-relevant fields. */
export function storedDrive(page: Page) {
  return page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: { postageStamps?: { depth: number; amount: string; batchTTL?: number }[] }[]
    }
    const stamp = doc.data?.[0]?.postageStamps?.[0]
    return stamp
      ? { depth: stamp.depth, amount: BigInt(stamp.amount).toString(), ttl: stamp.batchTTL ?? 0 }
      : undefined
  })
}

/**
 * Create an account, point it at the local chain, and give it a drive whose
 * batch the account's own signer owns on chain (the /dev action mirrors
 * production: the payment machinery creates the batch, the derived signer
 * owns it).
 */
export async function createAccountWithOnChainDrive(page: Page) {
  await page.addInitScript(
    ([rpcUrl, beeUrl]) => {
      localStorage.setItem(
        'swarm-id-network-settings',
        JSON.stringify({ beeNodeUrl: beeUrl, gnosisRpcUrl: rpcUrl }),
      )
    },
    [ANVIL_RPC_URL, BEE_NODE_URL],
  )

  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()

  await page.goto('/dev')
  await page.getByRole('tab', { name: 'Chain' }).click()
  // Also the path the README tells a newcomer to use.
  await page.getByRole('button', { name: 'Create drive to test with' }).click()
  await expect(page.getByText(/^Created drive: 0x[0-9a-f]{64}$/)).toBeVisible({
    timeout: ONCHAIN_TIMEOUT_MS,
  })
  await expect
    .poll(async () => (await storedDrive(page))?.depth, { timeout: ONCHAIN_TIMEOUT_MS })
    .toBe(DRIVE_DEPTH)

  await page.goto('/')
  await page.getByRole('tab', { name: 'Storage' }).click()
  await page.getByRole('button', { name: 'Expand drive' }).click()
}

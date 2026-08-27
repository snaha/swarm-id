// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The one on-chain drive case that has to MUTATE the chain every worker shares:
 * it removes the EIP-7702 delegate to reach the sequential fallback.
 *
 * Hence its own file and its own Playwright project, which `playwright.config.ts`
 * makes depend on the parallel one so it starts only after that has finished.
 * The delegate is a single address on the single local chain: while it is
 * empty, another worker whose purchase passed `supportsBundling()` a moment
 * earlier has its bundle mined against no code — a status-`0x1` no-op — and
 * dies claiming the batch could not be read back.
 *
 * The restore is an `afterEach` and not only a `finally`: hooks still run when
 * a test is killed by its timeout, a body `finally` does not, and the chain
 * outlives the run — a delegate left empty silently downgrades every purchase
 * afterwards, here and on the next run.
 *
 * Skipped automatically when the local chain is unreachable, so the suite never
 * breaks a run without the cluster.
 */
import { expect, test } from '@playwright/test'
import { gnosisMainnetSettings } from '@swarm-id/multichain'
import { devRpc } from '@swarm-id/multichain/dev'

import {
  ANVIL_RPC_URL,
  ONCHAIN_TIMEOUT_MS,
  chainUp,
  createAccountWithOnChainDrive,
  storedDrive,
} from './drive-onchain-setup'

/** The EIP-7702 delegate, from the settings the app itself resolves. */
const DELEGATE_ADDRESS = gnosisMainnetSettings().addresses.eip7702Delegate

const delegateCode = () =>
  devRpc(ANVIL_RPC_URL, 'eth_getCode', [DELEGATE_ADDRESS, 'latest']).then(String)
const setDelegateCode = (code: string) =>
  devRpc(ANVIL_RPC_URL, 'anvil_setCode', [DELEGATE_ADDRESS, code])

/** What the delegate held before this file touched it. */
let savedDelegateCode = ''
const restoreDelegate = async () => {
  if (savedDelegateCode) {
    await setDelegateCode(savedDelegateCode)
  }
}

test.skip(!chainUp, 'requires a local chain (pnpm dev:local, or pnpm dev:chain:detach)')

test.beforeAll(async () => {
  if (chainUp) {
    savedDelegateCode = await delegateCode()
  }
})

test.afterEach(restoreDelegate)

/**
 * The sequential path is only reachable where the EIP-7702 delegate is absent —
 * which, since every dev flow installs it, is nowhere by default.
 */
test('extends without the 7702 delegate, one transaction at a time', async ({ page }) => {
  test.setTimeout(ONCHAIN_TIMEOUT_MS * 2)
  await createAccountWithOnChainDrive(page)
  const before = await storedDrive(page)

  // After setup, so the batch creation that installs it has already run.
  await setDelegateCode('0x')
  try {
    expect(await delegateCode()).toBe('0x')

    await page.getByRole('button', { name: 'Extend lifespan' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('combobox').selectOption('days')
    await dialog.getByRole('button', { name: 'Increase' }).click()
    await dialog.getByRole('button', { name: 'Proceed' }).click()

    await expect(page.getByText('lifespan has been extended')).toBeVisible({
      timeout: ONCHAIN_TIMEOUT_MS,
    })
  } finally {
    // Puts it back as early as possible; `afterEach` is what covers the paths
    // this never reaches.
    await restoreDelegate()
  }

  const after = await storedDrive(page)
  expect(BigInt(after!.amount)).toBeGreaterThan(BigInt(before!.amount))
  expect(after!.ttl).toBeGreaterThan(before!.ttl)
  expect(after!.depth).toBe(before!.depth)
})

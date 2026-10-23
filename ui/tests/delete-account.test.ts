// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Deleting an account, end to end.
 *
 * A local account has nothing on chain or on Swarm, so its deletion is the
 * dialog alone and runs everywhere. A synced one dilutes its drives on chain
 * and publishes the deletion through its default drive before the record goes,
 * so that test needs both the local chain and a Bee node that has ingested the
 * batch — it skips itself without them.
 */
import { type Page, expect, test } from '@playwright/test'
import { MultichainClient, gnosisMainnetSettings } from '@swarm-id/multichain'

import {
  CHAIN_RPC_URL,
  DRIVE_SETTLE_TIMEOUT_MS,
  PASSWORD,
  addDrive,
  beeReachable,
  chainReachable,
  completeCreateFlow,
  fundPostageSigner,
  seedLocalChain,
  seedNoChain,
  waitForBatchIngestion,
} from './helpers'

/** Two purchases, two dilutions and a Swarm publish, each over 5s blocks. */
const SYNCED_DELETE_TIMEOUT_MS = 6 * 60 * 1000
/** Dilutions and the publish, after the dialog is confirmed. */
const DELETION_SETTLE_TIMEOUT_MS = 120_000

const chainUp = await chainReachable()
const beeUp = await beeReachable()

interface StoredAccount {
  name: string
  defaultPostageStampBatchID?: string
  postageStamps?: { batchID: string; depth: number; name?: string }[]
}

function storedAccounts(page: Page): Promise<StoredAccount[]> {
  return page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: StoredAccount[]
    }
    return doc.data ?? []
  })
}

async function createLocalAccount(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)
  const [account] = await storedAccounts(page)
  return account.name
}

async function openDeleteDialog(page: Page, name: string) {
  await page.getByRole('tab', { name: 'Account' }).click()
  await page.getByRole('button', { name: 'Delete account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete account' })
  await dialog.getByPlaceholder('Account name').fill(name)
  await dialog.getByPlaceholder('Account password').fill(PASSWORD)
  return dialog
}

test('deletes a local account', async ({ page }) => {
  await seedNoChain(page)
  const name = await createLocalAccount(page)

  await page.getByRole('tab', { name: 'Account' }).click()
  await page.getByRole('button', { name: 'Delete account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete account' })
  await expect(dialog.getByText('This will permanently delete your account.')).toBeVisible()
  // A local account has no drives to keep.
  await expect(dialog.getByRole('button', { name: 'Manage data' })).toHaveCount(0)

  const confirm = dialog.getByRole('button', { name: 'Delete my account' })
  await dialog.getByPlaceholder('Account password').fill(PASSWORD)
  // The name gates it, exactly.
  await expect(confirm).toBeDisabled()
  await dialog.getByPlaceholder('Account name').fill(name.toUpperCase())
  await expect(confirm).toBeDisabled()
  await dialog.getByPlaceholder('Account name').fill(name)
  await confirm.click()

  await expect(page.getByText('Account deleted')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()

  expect(await storedAccounts(page)).toHaveLength(0)
  await page.goto('/?signin')
  await expect(page.getByText(name)).toHaveCount(0)
})

test.describe('a synced account', () => {
  test.skip(!chainUp || !beeUp, 'requires a local chain and Bee cluster (pnpm dev:local)')

  test('dilutes the drives it does not keep, then deletes', async ({ page }) => {
    test.setTimeout(SYNCED_DELETE_TIMEOUT_MS)
    await seedLocalChain(page)
    const name = await createLocalAccount(page)
    for (let drive = 0; drive < 2; drive++) {
      await fundPostageSigner(page)
      await addDrive(page)
    }
    await expect
      .poll(async () => (await storedAccounts(page))[0].postageStamps?.length, {
        timeout: DRIVE_SETTLE_TIMEOUT_MS,
      })
      .toBe(2)
    // The deletion is published through the default drive.
    await waitForBatchIngestion(page)

    const [account] = await storedAccounts(page)
    const stamps = account.postageStamps ?? []
    const diluted = stamps.find((stamp) => stamp.batchID === account.defaultPostageStampBatchID)
    const kept = stamps.find((stamp) => stamp.batchID !== account.defaultPostageStampBatchID)
    if (!diluted || !kept) throw new Error('expected a default drive and another one')

    const dialog = await openDeleteDialog(page, name)
    await dialog.getByRole('button', { name: 'Manage data' }).click()
    // Keep the drive that is not the default. Unnamed, it shows its batch prefix.
    const keepSwitches = dialog.getByRole('switch', { name: /^Keep data on / })
    await expect(keepSwitches).toHaveCount(2)
    const keptName = kept.name?.trim() || `Drive ${kept.batchID.slice(0, 4)}`
    await dialog.getByRole('switch', { name: `Keep data on ${keptName}` }).click()
    await dialog.getByRole('button', { name: 'Delete my account' }).click()

    await expect(page.getByText('Account deleted')).toBeVisible({
      timeout: DELETION_SETTLE_TIMEOUT_MS,
    })
    await page.getByRole('button', { name: 'Done' }).click()
    expect(await storedAccounts(page)).toHaveLength(0)

    const chain = new MultichainClient(gnosisMainnetSettings({ rpcUrls: [CHAIN_RPC_URL] }))
    const read = async (batchId: string) => (await chain.getPostageBatch(`0x${batchId}`))?.depth
    expect(await read(diluted.batchID)).toBeGreaterThan(diluted.depth)
    expect(await read(kept.batchID)).toBe(kept.depth)
  })
})

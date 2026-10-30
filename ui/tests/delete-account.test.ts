// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Deleting an account, end to end.
 *
 * A local account has nothing on chain or on Swarm, so its deletion is the
 * dialog alone and runs everywhere. A synced one dilutes its drives on chain
 * and publishes the deletion through its default drive, so those tests need
 * the local chain and a warm Bee cluster: they skip themselves without them,
 * and the Three Devices workflow runs them (`playwright.devices.config.ts`).
 */
import { type Page, expect, test } from '@playwright/test'
import { MultichainClient, gnosisMainnetSettings } from '@swarm-id/multichain'
import { devRpc } from '@swarm-id/multichain/dev'

import {
  CHAIN_RPC_URL,
  DRIVE_SETTLE_TIMEOUT_MS,
  ID_ORIGIN,
  PASSWORD,
  addDrive,
  beeReachable,
  busRoomJoined,
  chainReachable,
  completeCreateFlow,
  fundPostageSigner,
  postageSignerAddress,
  seedLocalChain,
  seedNoChain,
  waitForBatchIngestion,
} from './helpers'

/** Two purchases, two dilutions and a Swarm publish, each over 5s blocks. */
const SYNCED_DELETE_TIMEOUT_MS = 6 * 60 * 1000
/** Dilutions and the publish, after the dialog is confirmed. */
const DELETION_SETTLE_TIMEOUT_MS = 120_000
/** The first page load can wait on the dev server compiling the home page. */
const FIRST_LOAD_TIMEOUT_MS = 15_000
/** A peer folding the deletion: from the bus at once, from Swarm on load. */
const PEER_FORGETS_TIMEOUT_MS = 60_000
const DELETED_ELSEWHERE = 'This account was deleted on another device'

const chainUp = await chainReachable()
const beeUp = await beeReachable()

interface StoredAccount {
  name: string
  deleted?: boolean
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
  const getStarted = page.getByRole('link', { name: 'Get started' }).first()
  await expect(getStarted).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT_MS })
  await getStarted.click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)
  const [account] = await storedAccounts(page)
  return account.name
}

/** A synced account with `count` drives, its default ingested by the node. */
async function createSyncedAccount(page: Page, count: number): Promise<StoredAccount> {
  await seedLocalChain(page)
  await createLocalAccount(page)
  for (let drive = 0; drive < count; drive++) {
    await fundPostageSigner(page)
    await addDrive(page)
  }
  await expect
    .poll(async () => (await storedAccounts(page))[0].postageStamps?.length, {
      timeout: DRIVE_SETTLE_TIMEOUT_MS,
    })
    .toBe(count)
  // The deletion is published through the default drive.
  await waitForBatchIngestion(page)
  return (await storedAccounts(page))[0]
}

async function chainDepth(batchId: string): Promise<number | undefined> {
  const chain = new MultichainClient(gnosisMainnetSettings({ rpcUrls: [CHAIN_RPC_URL] }))
  return (await chain.getPostageBatch(`0x${batchId}`))?.depth
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
    const account = await createSyncedAccount(page, 2)
    const stamps = account.postageStamps ?? []
    const diluted = stamps.find((stamp) => stamp.batchID === account.defaultPostageStampBatchID)
    const kept = stamps.find((stamp) => stamp.batchID !== account.defaultPostageStampBatchID)
    if (!diluted || !kept) throw new Error('expected a default drive and another one')

    const dialog = await openDeleteDialog(page, account.name)
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

    expect(await chainDepth(diluted.batchID)).toBeGreaterThan(diluted.depth)
    expect(await chainDepth(kept.batchID)).toBe(kept.depth)
  })

  // Leaving the payment screen must not read as "delete without diluting":
  // the user is asked, and Back keeps the account.
  test('asks before deleting undiluted when the gas is not paid', async ({ page }) => {
    test.setTimeout(SYNCED_DELETE_TIMEOUT_MS)
    const account = await createSyncedAccount(page, 1)
    const [drive] = account.postageStamps ?? []
    // No gas left, so the deletion has to ask for it.
    await devRpc(CHAIN_RPC_URL, 'anvil_setBalance', [await postageSignerAddress(page), '0x0'])

    const declineGas = async () => {
      const dialog = await openDeleteDialog(page, account.name)
      await dialog.getByRole('button', { name: 'Delete my account' }).click()
      const payment = page.getByRole('dialog', { name: 'Payment' })
      await payment.getByRole('button', { name: 'Close' }).click({
        timeout: DELETION_SETTLE_TIMEOUT_MS,
      })
      return page.getByRole('dialog', { name: "Drives can't be shortened" })
    }

    await (await declineGas()).getByRole('button', { name: 'Back' }).click()
    await expect(page.getByRole('dialog', { name: 'Delete account' })).toBeVisible()
    expect((await storedAccounts(page))[0].deleted).toBe(false)
    await page
      .getByRole('dialog', { name: 'Delete account' })
      .getByRole('button', { name: 'Close' })
      .click()

    await (await declineGas()).getByRole('button', { name: 'Delete anyway' }).click()
    const partial = page.getByRole('dialog', { name: "Some data couldn't be deleted" })
    await expect(partial).toBeVisible({ timeout: DELETION_SETTLE_TIMEOUT_MS })
    await partial.getByRole('button', { name: /^Reveal/ }).click()
    await expect(partial.getByText(/^0x[0-9a-f]{64}$/)).toBeVisible()
    expect(await storedAccounts(page)).toHaveLength(0)
    expect(await chainDepth(drive.batchID)).toBe(drive.depth)
  })

  // Two contexts are two devices. B is open and hears the bus delta; C was
  // closed throughout and learns of it from the feed when it next loads.
  test('a live device forgets the account at once, an offline one on its next load', async ({
    page,
    browser,
  }) => {
    test.setTimeout(SYNCED_DELETE_TIMEOUT_MS)
    const account = await createSyncedAccount(page, 1)
    const snapshot = await page.evaluate(() => ({
      accounts: localStorage.getItem('swarm-id-accounts'),
      current: localStorage.getItem('swarm-id-current-account-v2'),
      network: localStorage.getItem('swarm-id-network-settings'),
    }))
    const seed = (state: typeof snapshot) => {
      // Once per tab, so a device's own removal sticks across its reloads.
      if (sessionStorage.getItem('seeded')) return
      sessionStorage.setItem('seeded', '1')
      for (const [key, value] of [
        ['swarm-id-accounts', state.accounts],
        ['swarm-id-current-account-v2', state.current],
        ['swarm-id-network-settings', state.network],
      ] as const) {
        if (value) localStorage.setItem(key, value)
      }
    }

    const deviceB = await browser.newContext()
    const deviceC = await browser.newContext()
    try {
      await deviceB.addInitScript(seed, snapshot)
      const pageB = await deviceB.newPage()
      const joined = busRoomJoined(pageB)
      joined.catch(() => undefined)
      await pageB.goto(`${ID_ORIGIN}/`)
      await joined

      const dialog = await openDeleteDialog(page, account.name)
      await dialog.getByRole('button', { name: 'Delete my account' }).click()
      await expect(page.getByText('Account deleted')).toBeVisible({
        timeout: DELETION_SETTLE_TIMEOUT_MS,
      })

      await expect(pageB.getByText(DELETED_ELSEWHERE)).toBeVisible({
        timeout: PEER_FORGETS_TIMEOUT_MS,
      })
      expect(await storedAccounts(pageB)).toHaveLength(0)

      await deviceC.addInitScript(seed, snapshot)
      const pageC = await deviceC.newPage()
      await pageC.goto(`${ID_ORIGIN}/`)
      await expect(pageC.getByText(DELETED_ELSEWHERE)).toBeVisible({
        timeout: PEER_FORGETS_TIMEOUT_MS,
      })
      expect(await storedAccounts(pageC)).toHaveLength(0)
    } finally {
      await deviceB.close()
      await deviceC.close()
    }
  })
})

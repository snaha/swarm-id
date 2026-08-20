// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * "Paid for but never recorded" — the failure the whole journal exists for,
 * made to happen on purpose.
 *
 * A purchase is the one operation chain truth cannot resume on its own: nothing
 * looks batches up by owner, so a batch whose id was never written down is money
 * spent on a drive nobody can find. `fault-injection.ts` exists to make that
 * moment reachable rather than waiting for it in the wild, and this is what
 * arms it — at both points where a real failure costs something.
 *
 * Everything here is real: a real batch on the local chain, bought with real
 * BZZ by the account's own derived signer. The signer is funded out of band
 * first (`fundPostageSigner`), so no payment screen opens over the test —
 * because nothing needs paying for, not because a rail was suppressed.
 *
 * No Bee node: every figure is read from the chain, and the drive list is read
 * back out of localStorage. (`seedLocalChain` still points the app at the
 * cluster's node, as every suite does; nothing asserted here goes through it.)
 */
import { type Page, expect, test } from '@playwright/test'
import { MultichainClient, gnosisMainnetSettings } from '@swarm-id/multichain'

import {
  CHAIN_RPC_URL,
  addDrive,
  chainReachable,
  completeCreateFlow,
  confirmPurchased,
  fundPostageSigner,
  postageSignerAddress,
  seedLocalChain,
} from './helpers'

const chainUp = await chainReachable()
test.skip(!chainUp, 'requires a local chain (pnpm dev:cluster:start, or pnpm dev:chain:detach)')

/** On-chain work spans several 5s-block confirmations. */
const ONCHAIN_TIMEOUT_MS = 120_000
// A failed purchase and then a second run through the same chain work.
test.setTimeout(ONCHAIN_TIMEOUT_MS * 3)

/** Read directly, so the assertions do not go through the code under test. */
const chain = new MultichainClient(gnosisMainnetSettings({ rpcUrls: [CHAIN_RPC_URL] }))

/** `ui/src/lib/payment/fault-injection.ts` — DEV only, single-shot. */
const FAULT_KEY = 'swarm-id:fault-point'
/** `ui/src/lib/payment/operation-journal.svelte.ts` — device-local, unsynced. */
const JOURNAL_KEY = 'swarm-id:pending-operations'

/**
 * Arm the next paid operation to fail at `point`, the way /dev → Chain →
 * Simulate failure does. It disarms itself when it fires, so the attempt after
 * this one runs the resume path — which is the path under test.
 */
function armFault(page: Page, point: 'after-funding' | 'after-create') {
  return page.evaluate(([key, value]) => localStorage.setItem(key, value), [FAULT_KEY, point])
}

/** The batch ids this device is part-way through paying for, 0x-prefixed. */
function journalledBatchIds(page: Page): Promise<string[]> {
  return page.evaluate((key) => {
    const entries = JSON.parse(localStorage.getItem(key) ?? '[]') as { batchId: string }[]
    return entries.map((entry) => entry.batchId.toLowerCase())
  }, JOURNAL_KEY)
}

/** The batch ids actually recorded as drives, normalised to compare with those. */
function recordedBatchIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: { postageStamps?: { batchID: string; deletedAt?: number }[] }[]
    }
    return (doc.data?.[0]?.postageStamps ?? [])
      .filter((stamp) => stamp.deletedAt === undefined)
      .map((stamp) => `0x${stamp.batchID.replace(/^0x/, '')}`.toLowerCase())
  })
}

async function createFundedAccount(page: Page) {
  await seedLocalChain(page)
  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await expect(page).toHaveURL(/\/$/)
  await fundPostageSigner(page)
}

test('a purchase that dies after the batch exists is finished, not bought again', async ({
  page,
}) => {
  await createFundedAccount(page)
  const signer = await postageSignerAddress(page)

  await armFault(page, 'after-create')
  await addDrive(page)

  // The worst moment there is: the batch is on chain, the money is gone, and
  // the drive is recorded nowhere.
  await expect(page.getByText(/Injected failure at "after-create"/)).toBeVisible({
    timeout: ONCHAIN_TIMEOUT_MS,
  })
  const journalled = await journalledBatchIds(page)
  expect(journalled).toHaveLength(1)
  expect(await recordedBatchIds(page)).toHaveLength(0)

  // Close the failure and go back to Storage — where the money has to be
  // findable, since nothing else in the app knows this batch exists. Via the
  // dialog's own dismiss control: the footer button is also named "Close".
  await page.getByRole('dialog').getByLabel('Close').click()
  const paidBalance = await chain.getBzzBalance(signer)

  await expect(page.getByText(/never finished setting it up/)).toBeVisible()
  await page.getByRole('button', { name: 'Finish setting up' }).click()

  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible({ timeout: ONCHAIN_TIMEOUT_MS })
  await expect(page.getByText(/never finished setting it up/)).toBeHidden()
  expect(await journalledBatchIds(page)).toHaveLength(0)

  // The drive is the batch that was already paid for — adopted, not replaced by
  // a fresh purchase that would have abandoned it.
  expect(await recordedBatchIds(page)).toEqual(journalled)
  // And finishing cost nothing: a second `createBatch` would have moved this.
  expect(await chain.getBzzBalance(signer)).toBe(paidBalance)
})

test('a purchase that dies after the funds land spends them on the retry', async ({ page }) => {
  await createFundedAccount(page)
  const signer = await postageSignerAddress(page)
  const funded = await chain.getBzzBalance(signer)
  expect(funded).toBeGreaterThan(0n)

  await armFault(page, 'after-funding')
  await addDrive(page)

  await expect(page.getByText(/Injected failure at "after-funding"/)).toBeVisible({
    timeout: ONCHAIN_TIMEOUT_MS,
  })
  // Nothing was sent, so there is nothing to resume — and the journal must not
  // invent an entry for a batch that was never bought.
  expect(await journalledBatchIds(page)).toHaveLength(0)
  await expect(page.getByText(/never finished setting it up/)).toBeHidden()
  expect(await chain.getBzzBalance(signer)).toBe(funded)

  // Retry. The money is sitting at the owner address, so the funds check finds
  // nothing missing and no payment is raised — reaching the success screen at
  // all is the proof, since this browser has no wallet to pay with.
  await page.getByRole('dialog').getByRole('button', { name: 'Try again' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Proceed' }).click()
  await confirmPurchased(page)

  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toHaveCount(1)
  expect(await recordedBatchIds(page)).toHaveLength(1)
  expect(await journalledBatchIds(page)).toHaveLength(0)
  // The residual paid for it: one batch bought, out of one funding.
  expect(await chain.getBzzBalance(signer)).toBeLessThan(funded)
})

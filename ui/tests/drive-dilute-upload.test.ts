// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * A drive is made larger while an app writes to it (#463).
 *
 * One device, real browser, real transaction: the demo uploads, the drive is
 * resized on the local chain from the identity UI in another tab, and the
 * demo uploads again without reconnecting. The dilute doubles the batch's
 * slots; the write path has to take the new depth, keep its counters, and
 * leave what was uploaded before readable.
 *
 * Runs under `playwright.devices.config.ts`, with the same rig.
 */
import { type Page, expect, test } from '@playwright/test'

import { Device, UPLOAD_TIMEOUT_MS, readFromBee, rigUp } from './devices-rig'
import {
  ONCHAIN_TIMEOUT_MS,
  createAccountWithOnChainDrive,
  storedDrive,
} from './drive-onchain-setup'
import { addDrive, completeCreateFlow, mintToPostageSigner, waitForBatchIngestion } from './helpers'

/** Enough for a few hundred chunks. */
const MANY_CHUNKS_BYTES = 400_000
/** Far above what three uploads stamp, far below a misread counter. */
const MAX_PLAUSIBLE_STAMPS = 10_000
/** The last depth whose counters fitted 16 bits. */
const DEPTH_BEFORE_CROSSING = 31
/** A depth-31 batch for a month is thousands of BZZ, and doubling it as much again. */
const MINTED_BZZ_PLUR = 10n ** 22n // a million BZZ (16 decimals)

test.skip(
  !rigUp,
  'requires the chain, the Bee cluster, the demo and the signaling server (pnpm dev:local)',
)

/**
 * How many stamps the device has counted, summed over the buckets of every
 * batch in its cache (one account, one drive here). Read from the identity
 * origin's IndexedDB, which the proxy iframe shares.
 */
function cachedStampCount(identity: Page): Promise<number> {
  return identity.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('swarm-utilization-store')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const rows = db.transaction('chunks').objectStore('chunks').getAll()
          rows.onerror = () => reject(rows.error)
          rows.onsuccess = () => {
            let total = 0
            for (const row of rows.result as { data: Uint8Array }[]) {
              const view = new DataView(row.data.buffer, row.data.byteOffset, row.data.byteLength)
              for (let at = 0; at < view.byteLength; at += 4) total += view.getUint32(at, true)
            }
            db.close()
            resolve(total)
          }
        }
      }),
  )
}

/** Upload, make the drive one depth larger from the identity UI, upload again. */
async function uploadResizeUpload(device: Device) {
  const before = await storedDrive(device.page)
  await waitForBatchIngestion(device.page)

  const identity = await device.context.newPage()
  await device.connect()
  // Many chunks, so the cached counters are spread over many buckets.
  const first = await device.upload(undefined, undefined, MANY_CHUNKS_BYTES)
  const firstPayload = await readFromBee(first)
  expect(await device.partition(), 'the upload left no partition held').toBeDefined()

  await identity.goto('/')
  const stampedBefore = await cachedStampCount(identity)
  expect(stampedBefore, 'nothing was cached for the first upload').toBeGreaterThan(0)
  await identity.getByRole('tab', { name: 'Storage' }).click()
  await identity.getByRole('button', { name: 'Expand drive' }).click()
  await identity.getByRole('button', { name: 'Increase size' }).click()
  const dialog = identity.getByRole('dialog')
  await dialog.getByRole('combobox').selectOption(String(before!.depth + 1))
  await dialog.getByRole('button', { name: 'Proceed' }).click()
  await expect(identity.getByText('Your drive is now larger')).toBeVisible({
    timeout: ONCHAIN_TIMEOUT_MS,
  })
  expect((await storedDrive(identity))!.depth).toBe(before!.depth + 1)

  // The same demo tab, no reconnect: twice, so the second runs on a write
  // path that is settled at the new depth whatever the first one met.
  await device.upload()
  await device.upload()
  expect(await device.partition(), 'no partition held after the resize').toBeDefined()
  expect(await readFromBee(first), 'the earlier upload changed').toBe(firstPayload)
  // The device's own count of what it stamped: carried over the resize and
  // counted on from there. Misread rows show up as counts in the tens of
  // thousands, or as a total that went down.
  const stampedAfter = await cachedStampCount(identity)
  expect(stampedAfter, 'the cached counters did not survive the resize').toBeGreaterThan(
    stampedBefore,
  )
  expect(stampedAfter, 'the cached counters are not counts').toBeLessThan(MAX_PLAUSIBLE_STAMPS)
}

test('an app goes on uploading to a drive that was made larger under it', async ({ browser }) => {
  test.setTimeout(ONCHAIN_TIMEOUT_MS * 3 + UPLOAD_TIMEOUT_MS * 3)
  const device = await Device.open(browser, 'D')
  try {
    await createAccountWithOnChainDrive(device.page)
    await uploadResizeUpload(device)
  } finally {
    await device.close()
  }
})

// The crossing the issue is about: the device's cached counters were 16-bit
// rows up to depth 31 and 32-bit above. Nothing has to fill the batch; it only
// has to exist at that depth, and the chain will sell one to a signer whose
// balance was written into the token.
test('…and across depth 31 to 32', async ({ browser }) => {
  test.setTimeout(ONCHAIN_TIMEOUT_MS * 3 + UPLOAD_TIMEOUT_MS * 3)
  const device = await Device.open(browser, 'E')
  try {
    const { page } = device
    await page.goto('/')
    await page.getByRole('link', { name: 'Get started' }).first().click()
    await completeCreateFlow(page)
    await page.getByRole('button', { name: 'Stay local for now' }).click()
    await mintToPostageSigner(page, MINTED_BZZ_PLUR)
    await addDrive(page, { depth: DEPTH_BEFORE_CROSSING })
    await expect
      .poll(async () => (await storedDrive(page))?.depth, { timeout: ONCHAIN_TIMEOUT_MS })
      .toBe(DEPTH_BEFORE_CROSSING)

    await uploadResizeUpload(device)
  } finally {
    await device.close()
  }
})

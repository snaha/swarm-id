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
import { expect, test } from '@playwright/test'

import { Device, UPLOAD_TIMEOUT_MS, readFromBee, rigUp } from './devices-rig'
import {
  ONCHAIN_TIMEOUT_MS,
  createAccountWithOnChainDrive,
  storedDrive,
} from './drive-onchain-setup'
import { waitForBatchIngestion } from './helpers'

test.skip(
  !rigUp,
  'requires the chain, the Bee cluster, the demo and the signaling server (pnpm dev:local)',
)

test('an app goes on uploading to a drive that was made larger under it', async ({ browser }) => {
  test.setTimeout(ONCHAIN_TIMEOUT_MS * 3 + UPLOAD_TIMEOUT_MS * 3)
  const device = await Device.open(browser, 'D')
  try {
    await createAccountWithOnChainDrive(device.page)
    const before = await storedDrive(device.page)
    await waitForBatchIngestion(device.page)

    const identity = await device.context.newPage()
    await device.connect()
    const first = await device.upload()
    const firstPayload = await readFromBee(first)
    const held = await device.partition()
    expect(held, 'the upload left no partition held').toBeDefined()

    await identity.goto('/')
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
  } finally {
    await device.close()
  }
})

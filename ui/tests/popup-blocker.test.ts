// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * `client.connect()` under a real popup blocker (#751).
 *
 * The click lands on the dApp page, not in the iframe, and Firefox refuses an
 * iframe a popup on the strength of it. So the client opens the popup itself,
 * synchronously in the click, carrying the challenge the proxy armed ahead of
 * it; the popup hands a partitioned session over among the page's frames.
 * This keeps that measured under a real blocker.
 *
 * Every other project runs with `--disable-popup-blocking`, and Playwright's
 * bundled Chromium never blocks even without it, so this runs on Google Chrome
 * (`chrome-popup-blocked` in `playwright.config.ts`). The first test proves the
 * blocker is on; without it the second would pass on any rig and prove nothing.
 *
 * Cross-site the same way as `bus-propagation.test.ts`: the demo under a
 * loopback literal, the proxy at `http://localhost:5500`.
 */
import { expect, test } from '@playwright/test'

import {
  ID_ORIGIN,
  completeCreateFlow,
  expectProxyPartitioned,
  goToApp,
  openConnectPopup,
  partitionedDemoOrigin,
} from './helpers'

const demoOrigin = await partitionedDemoOrigin()
const NO_LOOPBACK_LITERAL =
  'the demo dev server answered on neither loopback literal — nothing to browse cross-site'
if (!demoOrigin && process.env.CI) {
  throw new Error(NO_LOOPBACK_LITERAL)
}
test.skip(!demoOrigin, NO_LOOPBACK_LITERAL)

/** Past the transient-activation window, so nothing `evaluate` grants is left. */
const AFTER_ACTIVATION_MS = 6000

test('the rig blocks a gesture-less popup from the proxy iframe', async ({ page }) => {
  await page.goto(`${demoOrigin}/account`)
  await expectProxyPartitioned(page)
  const proxy = page.frames().find((frame) => frame.url().startsWith(ID_ORIGIN))!
  const opened = await proxy.evaluate(
    (delay) =>
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(window.open('about:blank') !== null), delay),
      ),
    AFTER_ACTIVATION_MS,
  )
  expect(opened, 'the popup blocker is off — this project proves nothing without it').toBe(false)
})

test('client.connect() opens its popup through the blocker', async ({ page }) => {
  await page.goto(`${demoOrigin}/account`)
  await expectProxyPartitioned(page)

  const popup = await openConnectPopup(page)
  // Not proven shared, so the popup carries the proxy's armed challenge — the
  // only way the session reaches a partitioned iframe.
  await expect(popup).toHaveURL(/challenge=/)

  await completeCreateFlow(popup)
  await expect(popup).toHaveURL(/\/connect\/done$/)
  await goToApp(popup)
  await expect(page.getByRole('heading', { name: 'Identity' })).toBeVisible({ timeout: 15000 })
})

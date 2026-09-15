// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * `client.connect()` under a real popup blocker (#751).
 *
 * On a partitioned session the client asks the PROXY to open the popup, so
 * `window.opener` points at the iframe and the session can be handed over. The
 * click that triggers it lands on the dApp page, not in the iframe, so the
 * question is whether the browser's popup blocker lets the iframe open a window
 * on the strength of that click. PR #630 could not measure it and added a
 * parent-opens fallback; measured by hand since, Chrome, Brave, Firefox and
 * iOS Safari all let the delegated popup through. This keeps that measured.
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

test('client.connect() opens the delegated popup through the blocker', async ({ page }) => {
  await page.goto(`${demoOrigin}/account`)
  await expectProxyPartitioned(page)

  const popup = await openConnectPopup(page)
  // Only the proxy puts a challenge in the URL. A popup without one was opened
  // by the parent — the fallback — which means the iframe's own open was blocked.
  await expect(popup).toHaveURL(/challenge=/)

  await completeCreateFlow(popup)
  await expect(popup).toHaveURL(/\/connect\/done$/)
  await goToApp(popup)
  await expect(page.getByRole('heading', { name: 'Identity' })).toBeVisible({ timeout: 15000 })
})
